import { formatUnits, type Address } from "viem";
import { config, USDC_DECIMALS } from "../config/index.js";
import {
  getEthBalance,
  getEthBalanceFormatted,
  getUsdcBalance,
  getUsdcBalanceFormatted,
} from "../chain/wallet.js";
import { getTokenPrice } from "../scanner/dexscreener.js";
import { buyToken, type SwapResult } from "../swap/executor.js";
import {
  getPositions,
  isTradingPaused,
  addPosition,
  checkTpSl,
  getFocusedToken,
  getPosition,
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
  notifyTakeProfit,
  notifyReentry,
} from "../telegram/bot.js";
import {
  reviewPortfolio,
  explainTrade,
  isAIEnabled,
} from "../ai/analyst.js";
import { logger } from "../utils/logger.js";

// ── State ──────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 10_000;  // 10 seconds
const ETH_CHECK_TICKS = 6;        // Every 6 ticks = 60 seconds
const PORTFOLIO_REVIEW_TICKS = 60; // Every 60 ticks = ~10 minutes

let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let isTicking = false;            // Guard against overlapping ticks
let lastEthWarning = 0;           // Debounce: warn at most once per hour
let reentryCooldownUntil = 0;     // Don't re-buy until this timestamp

// ── Focused token tick ─────────────────────────────────────────────

/**
 * Core trading tick — runs every 10 seconds.
 *  1. Periodic ETH balance check
 *  2. Periodic AI portfolio review
 *  3. Focused-token buy/SL/TP loop
 */
async function tick(): Promise<void> {
  if (isTicking) return;
  isTicking = true;
  tickCount++;

  try {
    // Periodic ETH balance check
    if (tickCount % ETH_CHECK_TICKS === 0) {
      await checkEthBalance();
    }

    // Periodic AI portfolio review
    if (tickCount % PORTFOLIO_REVIEW_TICKS === 0 && isAIEnabled()) {
      await doPortfolioReview();
    }

    // Focused token trading
    const focused = getFocusedToken();
    if (!focused || !focused.active) return;

    const currentPrice = await getTokenPrice(focused.address as Address);
    if (currentPrice === null) {
      logger.warn({ token: focused.address }, "Could not fetch price — skipping tick");
      return;
    }

    const position = getPosition(focused.address);

    if (!position) {
      // ── No open position — attempt to buy ─────────────────────
      if (isTradingPaused()) {
        logger.debug("Trading paused — skipping buy");
        return;
      }

      if (Date.now() < reentryCooldownUntil) {
        logger.debug(
          { remainMs: reentryCooldownUntil - Date.now() },
          "Re-entry cooldown active — skipping buy"
        );
        return;
      }

      const usdcBalRaw = await getUsdcBalance();
      const usdcBal = parseFloat(formatUnits(usdcBalRaw, USDC_DECIMALS));

      if (usdcBal < config.minUsdcBalance) {
        logger.warn({ usdcBal, min: config.minUsdcBalance }, "USDC below minimum — skipping buy");
        return;
      }

      const buyAmount = (usdcBal * (config.tradePercent / 100)).toFixed(USDC_DECIMALS);

      logger.info(
        { symbol: focused.symbol, address: focused.address, amount: buyAmount, price: currentPrice },
        "Focused token — no position, executing buy"
      );

      try {
        const result: SwapResult = config.dryRun
          ? { success: true, buyAmount: buyAmount }
          : await buyToken(focused.address as Address, buyAmount);

        if (result.success) {
          const newPosition: Position = {
            tokenAddress: focused.address,
            tokenSymbol: focused.symbol,
            tokenName: focused.name,
            entryPrice: currentPrice,
            currentPrice,
            highestPrice: currentPrice,
            quantity: result.buyAmount ?? "0",
            usdcInvested: buyAmount,
            entryTimestamp: Date.now(),
            buyTxHash: result.txHash ?? "",
            dexScreenerUrl: focused.dexScreenerUrl ?? "",
          };

          addPosition(newPosition);

          if (result.txHash) {
            await notifyBuy(focused.symbol, buyAmount, currentPrice, result.txHash);
          } else if (config.dryRun) {
            await notifyReentry(focused.symbol, buyAmount, currentPrice);
          }

          if (isAIEnabled()) {
            const explanation = await explainTrade("buy", focused.symbol, {
              price: currentPrice,
              stopLoss: `${focused.stopLossPercent}%`,
              takeProfit: `${focused.takeProfitPercent}%`,
              usdcInvested: buyAmount,
            });
            if (explanation) await notify(`🤖 <i>${explanation}</i>`, "HTML");
          }

          logger.info({ symbol: focused.symbol, txHash: result.txHash }, "Focused buy successful");
        } else {
          logger.error({ error: result.error }, "Focused buy failed");
          await notifyError(`Buy ${focused.symbol}`, result.error ?? "Unknown error");
        }
      } catch (buyErr) {
        logger.error({ err: buyErr }, "Buy threw exception");
        await notifyError(`Buy ${focused.symbol}`, String(buyErr));
      }
    } else {
      // ── Position open — check SL/TP ────────────────────────────
      position.currentPrice = currentPrice;
      if (currentPrice > position.highestPrice) {
        position.highestPrice = currentPrice;
      }

      const outcome = checkTpSl(
        position,
        focused.stopLossPercent,
        focused.takeProfitPercent,
        currentPrice
      );

      const slPrice = (position.entryPrice * (1 - focused.stopLossPercent / 100)).toPrecision(6);
      const tpPrice = (position.entryPrice * (1 + focused.takeProfitPercent / 100)).toPrecision(6);

      logger.debug(
        { symbol: focused.symbol, price: currentPrice, sl: slPrice, tp: tpPrice, outcome },
        "SL/TP check"
      );

      if (outcome === "hold") return;

      // SL or TP triggered ─ sell
      const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const triggerLabel = outcome === "take-profit" ? "TAKE PROFIT" : "STOP LOSS";

      logger.info(
        { symbol: focused.symbol, outcome, profit: profitPercent.toFixed(2) },
        `${triggerLabel} TRIGGERED`
      );

      const sellResult = config.dryRun
        ? { position, result: { success: true, buyAmount: position.usdcInvested } as SwapResult }
        : await forceSell(focused.address, outcome);

      if (sellResult?.result.success) {
        if (outcome === "take-profit") {
          await notifyTakeProfit(
            focused.symbol,
            profitPercent,
            sellResult.result.txHash ?? "",
            currentPrice
          );
        } else {
          await notifyStopLoss(focused.symbol, focused.stopLossPercent, profitPercent, true);
        }

        if (sellResult.result.txHash) {
          await notifySell(
            focused.symbol,
            sellResult.result.buyAmount ?? "0",
            currentPrice,
            profitPercent,
            outcome,
            sellResult.result.txHash
          );
        }

        reentryCooldownUntil = Date.now() + config.reentryCooldownSec * 1000;
        logger.info({ cooldownSec: config.reentryCooldownSec }, "Re-entry cooldown started");
      } else {
        logger.error(
          { error: sellResult?.result.error },
          `${triggerLabel} sell FAILED — will retry next tick`
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Tick error");
  } finally {
    isTicking = false;
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

// ── AI portfolio review ────────────────────────────────────────────

async function doPortfolioReview(): Promise<void> {
  try {
    const positions = getPositions();
    if (positions.length === 0) return;

    const ethBal = await getEthBalanceFormatted();
    const usdcBal = await getUsdcBalanceFormatted();
    const advice = await reviewPortfolio(positions, parseFloat(usdcBal), ethBal);
    if (!advice) return;

    logger.info({ sentiment: advice.overallSentiment, summary: advice.summary }, "AI portfolio review");

    for (const posAdvice of advice.positionAdvice) {
      if (posAdvice.action === "sell") {
        logger.info({ symbol: posAdvice.symbol, reason: posAdvice.reasoning }, "AI recommends selling");
        const pos = positions.find((p) => p.tokenSymbol === posAdvice.symbol);
        if (pos) {
          await notify(`🤖 <b>AI SELL: ${posAdvice.symbol}</b>\nReason: ${posAdvice.reasoning}`, "HTML");
          await forceSell(pos.tokenAddress, "ai-sell");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "AI portfolio review failed");
  }
}

// ── Scheduler ──────────────────────────────────────────────────────

/**
 * Start the focused-token trading loop (10 s ticks).
 * Runs an immediate tick, then polls every 10 seconds.
 */
export function startFocusedTradingLoop(): void {
  if (tickInterval) return; // already running

  logger.info(
    { tickMs: TICK_INTERVAL_MS, stopLoss: config.stopLossPercent, takeProfit: config.takeProfitPercent },
    "Starting focused trading loop"
  );

  // Fire immediately, then on interval
  tick().catch((err) => logger.error({ err }, "Initial tick failed"));

  tickInterval = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Tick error"));
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the focused-token trading loop gracefully.
 */
export function stopFocusedTradingLoop(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info("Focused trading loop stopped");
  }
}
