import cron from "node-cron";
import { formatUnits, type Address } from "viem";
import { config, USDC_DECIMALS } from "../config/index.js";
import {
  getEthBalance,
  getEthBalanceFormatted,
  getUsdcBalance,
  getUsdcBalanceFormatted,
} from "../chain/wallet.js";
import { scanForCandidates, getTokenPrice } from "../scanner/dexscreener.js";
import { buyToken } from "../swap/executor.js";
import {
  getOpenPositionCount,
  getHeldTokenAddresses,
  getBlacklist,
  getPositions,
  isTradingPaused,
  evaluateStopLosses,
  addPosition,
  computeStopPrice,
  forceSell,
  type Position,
} from "../positions/manager.js";
import {
  notify,
  notifyBuy,
  notifySell,
  notifyLowEth,
  notifyError,
  notifyStopLoss,
} from "../telegram/bot.js";
import {
  analyzeTokenCandidates,
  reviewPortfolio,
  explainTrade,
  isAIEnabled,
} from "../ai/analyst.js";
import { logger } from "../utils/logger.js";

// ── State ──────────────────────────────────────────────────────────

let cronTask: cron.ScheduledTask | null = null;
let isRunning = false; // Guard against overlapping cycles
let lastEthWarning = 0; // Debounce ETH warnings (once per hour)

// ── Main trading loop ──────────────────────────────────────────────

/**
 * Execute a single trading cycle:
 *  1. Check ETH balance
 *  2. Evaluate stop-losses on existing positions
 *  3. Scan for new opportunities (if under max positions)
 *  4. Execute buys
 */
async function tradingCycle(): Promise<void> {
  if (isRunning) {
    logger.warn("Previous cycle still running, skipping");
    return;
  }

  isRunning = true;
  const cycleStart = Date.now();

  try {
    logger.info("═══════════════════════════════════════════");
    logger.info("Starting trading cycle");
    logger.info("═══════════════════════════════════════════");

    // ── Step 1: Check ETH balance ──────────────────────────────
    await checkEthBalance();

    // ── Step 2: Evaluate stop-losses ───────────────────────────
    const stopLossResults = await evaluateStopLosses();

    for (const { position, result, reason } of stopLossResults) {
      const profitPercent =
        ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const { trailPercent } = computeStopPrice(position);

      await notifyStopLoss(
        position.tokenSymbol,
        trailPercent,
        profitPercent,
        result.success
      );

      if (result.success && result.txHash) {
        await notifySell(
          position.tokenSymbol,
          result.buyAmount ?? "0",
          position.currentPrice,
          profitPercent,
          reason,
          result.txHash
        );
      }
    }

    // ── Step 3: AI portfolio review ──────────────────────────────
    if (isAIEnabled()) {
      const ethBal = await getEthBalanceFormatted();
      const usdcBal = await getUsdcBalanceFormatted();
      const currentPositions = getPositions();
      const advice = await reviewPortfolio(
        currentPositions,
        parseFloat(usdcBal),
        ethBal
      );

      if (advice) {
        logger.info(
          { sentiment: advice.overallSentiment, summary: advice.summary },
          "AI portfolio review"
        );

        // Act on AI sell/tighten-stop recommendations
        for (const posAdvice of advice.positionAdvice) {
          if (posAdvice.action === "sell") {
            logger.info(
              { symbol: posAdvice.symbol, reason: posAdvice.reasoning },
              "AI recommends selling position"
            );
            // Find the position and force-sell it
            const pos = currentPositions.find(
              (p) => p.tokenSymbol === posAdvice.symbol
            );
            if (pos) {
              await notify(
                `🤖 <b>AI SELL: ${posAdvice.symbol}</b>\n` +
                  `Reason: ${posAdvice.reasoning}`,
                "HTML"
              );
              await forceSell(pos.tokenAddress);
            }
          }
        }
      }
    }

    // ── Step 4: Check if trading is paused ─────────────────────
    if (isTradingPaused()) {
      logger.info("Trading is paused — skipping buy scan");
      return;
    }

    // ── Step 5: Check for new buy opportunities ────────────────
    const openCount = getOpenPositionCount();
    const availableSlots = config.maxPositions - openCount;

    if (availableSlots <= 0) {
      logger.info(
        { positions: openCount, max: config.maxPositions },
        "Max positions reached — skipping scan"
      );
      return;
    }

    // Check USDC balance
    const usdcBalanceRaw = await getUsdcBalance();
    const usdcBalance = parseFloat(formatUnits(usdcBalanceRaw, USDC_DECIMALS));

    if (usdcBalance < config.minUsdcBalance) {
      logger.info(
        { usdcBalance, min: config.minUsdcBalance },
        "USDC below minimum — skipping buys"
      );
      return;
    }

    // Calculate investment amount (10% of balance)
    const investAmount = usdcBalance * (config.tradePercent / 100);
    const investAmountStr = investAmount.toFixed(USDC_DECIMALS);

    logger.info(
      { usdcBalance, investAmount, availableSlots },
      "Looking for buy opportunities"
    );

    // Scan DexScreener
    const heldTokens = getHeldTokenAddresses();
    const blacklist = getBlacklist();
    const candidates = await scanForCandidates(heldTokens, blacklist);

    if (candidates.length === 0) {
      logger.info("No suitable candidates found this cycle");
      return;
    }

    // ── Step 6: AI analysis of candidates ──────────────────────
    const currentPositions = getPositions();
    const aiVerdicts = await analyzeTokenCandidates(
      candidates,
      currentPositions,
      usdcBalance
    );

    // Filter to only AI-approved buys, sorted by confidence
    const approvedBuys = aiVerdicts
      .filter((v) => v.action === "buy" && v.confidence >= 40)
      .sort((a, b) => b.confidence - a.confidence);

    if (approvedBuys.length === 0) {
      logger.info("AI rejected all candidates this cycle");
      if (isAIEnabled()) {
        const skippedSymbols = aiVerdicts.map(
          (v) => `${v.symbol} (${v.reasoning})`
        );
        logger.info({ skipped: skippedSymbols }, "AI skip reasons");
      }
      return;
    }

    logger.info(
      {
        approved: approvedBuys.length,
        total: candidates.length,
        aiEnabled: isAIEnabled(),
      },
      "Candidates filtered through AI"
    );

    // Buy AI-approved candidates (up to available slots)
    const toBuy = approvedBuys.slice(0, availableSlots);

    for (const verdict of toBuy) {
      // Find the original candidate data
      const candidate = candidates.find(
        (c) => c.address.toLowerCase() === verdict.address.toLowerCase()
      );
      if (!candidate) continue;

      // Recheck USDC balance before each buy (it decreases)
      const currentUsdcRaw = await getUsdcBalance();
      const currentUsdc = parseFloat(formatUnits(currentUsdcRaw, USDC_DECIMALS));

      if (currentUsdc < config.minUsdcBalance) {
        logger.info("USDC depleted below minimum, stopping buys");
        break;
      }

      // Use AI-suggested allocation if provided, else default
      const allocPercent = verdict.suggestedAllocPercent ?? config.tradePercent;
      const buyAmount = (currentUsdc * (allocPercent / 100)).toFixed(
        USDC_DECIMALS
      );

      logger.info(
        {
          symbol: candidate.symbol,
          address: candidate.address,
          amount: buyAmount,
          aiConfidence: verdict.confidence,
          aiRisk: verdict.riskLevel,
        },
        "AI-approved buy — executing"
      );

      try {
        const result = await buyToken(candidate.address, buyAmount);

        if (result.success) {
          // Get the current price for position tracking
          const price =
            candidate.priceUsd ||
            (await getTokenPrice(candidate.address)) ||
            0;

          const position: Position = {
            tokenAddress: candidate.address,
            tokenSymbol: candidate.symbol,
            tokenName: candidate.name,
            entryPrice: price,
            currentPrice: price,
            highestPrice: price,
            quantity: result.buyAmount ?? "0",
            usdcInvested: buyAmount,
            entryTimestamp: Date.now(),
            buyTxHash: result.txHash ?? "",
            dexScreenerUrl: candidate.dexScreenerUrl,
          };

          addPosition(position);

          // Generate AI explanation for Telegram notification
          const aiExplanation = await explainTrade("buy", candidate.symbol, {
            volume24h: candidate.volume24h,
            liquidity: candidate.liquidity,
            priceChange1h: candidate.priceChange1h,
            aiConfidence: verdict.confidence,
            aiRisk: verdict.riskLevel,
            aiReasoning: verdict.reasoning,
          });

          if (result.txHash) {
            await notifyBuy(candidate.symbol, buyAmount, price, result.txHash);
            if (aiExplanation) {
              await notify(`🤖 <i>${aiExplanation}</i>`, "HTML");
            }
          }

          logger.info(
            { symbol: candidate.symbol, txHash: result.txHash },
            "Buy successful"
          );
        } else {
          logger.error(
            { symbol: candidate.symbol, error: result.error },
            "Buy failed"
          );
          await notifyError(
            `Buy ${candidate.symbol}`,
            result.error ?? "Unknown error"
          );
        }
      } catch (err) {
        logger.error({ err, symbol: candidate.symbol }, "Buy threw exception");
        await notifyError(`Buy ${candidate.symbol}`, String(err));
      }

      // Small delay between buys to avoid rate limits
      await sleep(2000);
    }
  } catch (err) {
    logger.error({ err }, "Trading cycle failed");
    await notifyError("Trading cycle", String(err));
  } finally {
    isRunning = false;
    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    logger.info({ elapsed: `${elapsed}s` }, "Trading cycle complete");
  }
}

// ── ETH balance check ──────────────────────────────────────────────

async function checkEthBalance(): Promise<void> {
  try {
    const ethBalance = await getEthBalance();
    const ethFormatted = await getEthBalanceFormatted();

    if (ethBalance < config.ethWarnThreshold) {
      const now = Date.now();
      // Only warn once per hour
      if (now - lastEthWarning > 60 * 60 * 1000) {
        lastEthWarning = now;
        logger.warn({ balance: ethFormatted }, "Low ETH balance!");
        await notifyLowEth(ethFormatted);
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to check ETH balance");
  }
}

// ── Scheduler ──────────────────────────────────────────────────────

/**
 * Start the trading orchestrator.
 * Runs an immediate cycle, then schedules repeats.
 */
export function startOrchestrator(): void {
  const intervalMin = config.scanIntervalMin;

  logger.info(
    { intervalMin, maxPositions: config.maxPositions, tradePercent: config.tradePercent },
    "Starting orchestrator"
  );

  // Run immediately on startup
  tradingCycle().catch((err) => {
    logger.error({ err }, "Initial trading cycle failed");
  });

  // Schedule recurring cycles
  cronTask = cron.schedule(`*/${intervalMin} * * * *`, () => {
    tradingCycle().catch((err) => {
      logger.error({ err }, "Scheduled trading cycle failed");
    });
  });

  logger.info(`Orchestrator scheduled: every ${intervalMin} minutes`);
}

/**
 * Stop the orchestrator gracefully.
 */
export function stopOrchestrator(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info("Orchestrator stopped");
  }
}

// ── Utilities ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
