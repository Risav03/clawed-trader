import { type Address } from "viem";
import { config } from "../config/index.js";
import {
  getEthBalance,
  getEthBalanceFormatted,
} from "../chain/wallet.js";
import { getTokenPrice } from "../scanner/dexscreener.js";
import {
  getActiveMonitors,
  getPosition,
  updateMonitor,
  removeMonitor,
  forceSellByAddress,
  type MonitoredToken,
} from "../positions/manager.js";
import { buyToken } from "../swap/executor.js";
import {
  notify,
  notifyStopLossHit,
  notifyError,
  notifyLowEth,
  notifyMilestone,
  notifyBuyback,
  notifyBudgetExhausted,
} from "../telegram/bot.js";
import { logger } from "../utils/logger.js";

// ── State ──────────────────────────────────────────────────────────

const ETH_CHECK_INTERVAL = 10; // Check ETH every N ticks (10 * 30s = 5 min)

let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let isTicking = false;
let lastEthWarning = 0;

// ── Core monitor tick ──────────────────────────────────────────────

/**
 * Core monitoring tick — runs every 30 seconds.
 * For each active monitor:
 *   1. Fetch current price
 *   2. If price <= stopLossPrice → sell all holdings, deactivate monitor
 *   3. Check for 25% price increase milestones → notify on Telegram
 */
async function tick(): Promise<void> {
  if (isTicking) return;
  isTicking = true;
  tickCount++;

  try {
    // Periodic ETH balance check
    if (tickCount % ETH_CHECK_INTERVAL === 0) {
      await checkEthBalance();
    }

    const monitors = getActiveMonitors();
    if (monitors.length === 0) return;

    for (const monitor of monitors) {
      try {
        await processMonitor(monitor);
      } catch (err) {
        logger.error({ err, symbol: monitor.symbol }, "Error processing monitor");
      }
    }
  } catch (err) {
    logger.error({ err }, "Tick error");
  } finally {
    isTicking = false;
  }
}

/**
 * Process a single monitored token.
 * Branches behavior based on monitor type:
 *  - 'standard': stop-loss + 25% milestones (original behavior)
 *  - 'simple':   stop-loss (auto-sell if position, else notify-only) + custom % milestones
 *  - 'buyback':  custom % milestones + auto-buy on cumulative drop levels
 */
async function processMonitor(monitor: MonitoredToken): Promise<void> {
  const currentPrice = await getTokenPrice(monitor.address as Address);
  if (currentPrice === null) {
    logger.warn({ token: monitor.address, symbol: monitor.symbol }, "Could not fetch price — skipping");
    return;
  }

  const monitorType = monitor.type ?? "standard";

  logger.debug(
    {
      symbol: monitor.symbol,
      type: monitorType,
      currentPrice,
      stopLoss: monitor.stopLossPrice,
      entryPrice: monitor.entryPrice,
      lastMilestone: monitor.lastNotifiedMilestone,
    },
    "Price check"
  );

  switch (monitorType) {
    case "standard":
      await processStandard(monitor, currentPrice);
      break;
    case "simple":
      await processSimple(monitor, currentPrice);
      break;
    case "buyback":
      await processBuyback(monitor, currentPrice);
      break;
    default:
      await processStandard(monitor, currentPrice);
  }
}

// ── Standard monitor (original behavior) ───────────────────────────

async function processStandard(monitor: MonitoredToken, currentPrice: number): Promise<void> {
  // ── Stop-loss check ────────────────────────────────────────────
  if (currentPrice <= monitor.stopLossPrice) {
    logger.info(
      { symbol: monitor.symbol, currentPrice, stopLoss: monitor.stopLossPrice },
      "STOP-LOSS TRIGGERED — selling all holdings"
    );

    const result = await forceSellByAddress(monitor.address, monitor.symbol, "stop-loss");

    if (result.success) {
      const lossPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
      await notifyStopLossHit(
        monitor.symbol,
        currentPrice,
        monitor.stopLossPrice,
        lossPercent,
        result.txHash ?? "",
        true
      );
      removeMonitor(monitor.address);
      logger.info({ symbol: monitor.symbol }, "Monitor removed after stop-loss sell");
    } else {
      await notifyStopLossHit(
        monitor.symbol,
        currentPrice,
        monitor.stopLossPrice,
        0,
        "",
        false
      );
      logger.error(
        { symbol: monitor.symbol, error: result.error },
        "Stop-loss sell FAILED — will retry next tick"
      );
    }

    return;
  }

  // ── 25% milestone check ────────────────────────────────────────
  if (monitor.entryPrice > 0) {
    const gainPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
    const currentMilestone = Math.floor(gainPercent / 25) * 25;

    if (currentMilestone > 0 && currentMilestone > monitor.lastNotifiedMilestone) {
      await notifyMilestone(
        monitor.symbol,
        currentPrice,
        monitor.entryPrice,
        currentMilestone
      );
      updateMonitor(monitor.address, { lastNotifiedMilestone: currentMilestone });
      logger.info(
        { symbol: monitor.symbol, milestone: currentMilestone, price: currentPrice },
        "Price milestone reached"
      );
    }
  }
}

// ── Simple monitor ─────────────────────────────────────────────────

async function processSimple(monitor: MonitoredToken, currentPrice: number): Promise<void> {
  const notifyPct = monitor.notifyPercent ?? 25;

  // ── Stop-loss check ────────────────────────────────────────────
  if (monitor.stopLossPrice > 0 && currentPrice <= monitor.stopLossPrice) {
    const position = getPosition(monitor.address);

    if (position) {
      // Position exists — auto-sell
      logger.info(
        { symbol: monitor.symbol, currentPrice, stopLoss: monitor.stopLossPrice },
        "SIMPLE STOP-LOSS — selling position"
      );

      const result = await forceSellByAddress(monitor.address, monitor.symbol, "stop-loss");
      const lossPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;

      await notifyStopLossHit(
        monitor.symbol,
        currentPrice,
        monitor.stopLossPrice,
        lossPercent,
        result.txHash ?? "",
        result.success
      );
    } else {
      // No position — notify only
      logger.info(
        { symbol: monitor.symbol, currentPrice, stopLoss: monitor.stopLossPrice },
        "SIMPLE STOP-LOSS — notify only (no position)"
      );

      const lossPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
      await notify(
        `🛑 <b>STOP-LOSS HIT: ${monitor.symbol}</b>\n\n` +
          `💵 Price: $${currentPrice.toPrecision(6)}\n` +
          `🎯 Stop-loss was: $${monitor.stopLossPrice}\n` +
          `📉 Change from entry: ${lossPercent >= 0 ? "+" : ""}${lossPercent.toFixed(1)}%\n` +
          `ℹ️ No position held — notification only`,
        "HTML"
      );
    }

    removeMonitor(monitor.address);
    logger.info({ symbol: monitor.symbol }, "Simple monitor removed after stop-loss");
    return;
  }

  // ── Custom % milestone check (upward only) ────────────────────
  if (monitor.entryPrice > 0) {
    const gainPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
    const currentMilestone = Math.floor(gainPercent / notifyPct) * notifyPct;

    if (currentMilestone > 0 && currentMilestone > monitor.lastNotifiedMilestone) {
      await notifyMilestone(
        monitor.symbol,
        currentPrice,
        monitor.entryPrice,
        currentMilestone
      );
      updateMonitor(monitor.address, { lastNotifiedMilestone: currentMilestone });
      logger.info(
        { symbol: monitor.symbol, milestone: currentMilestone, price: currentPrice },
        "Simple monitor milestone reached"
      );
    }
  }
}

// ── Buyback monitor ────────────────────────────────────────────────

async function processBuyback(monitor: MonitoredToken, currentPrice: number): Promise<void> {
  const notifyPct = monitor.notifyPercent ?? 25;
  const buybackPct = monitor.buybackPercent ?? 10;
  const usdcPerBuy = monitor.usdcPerBuyback ?? 0;
  const totalBudget = monitor.totalUsdcBudget ?? 0;
  let usdcSpent = monitor.usdcSpent ?? 0;
  let lastBuybackLevel = monitor.lastBuybackLevel ?? 0;

  // ── Custom % milestone check (upward only) ────────────────────
  if (monitor.entryPrice > 0) {
    const gainPercent = ((currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
    const currentMilestone = Math.floor(gainPercent / notifyPct) * notifyPct;

    if (currentMilestone > 0 && currentMilestone > monitor.lastNotifiedMilestone) {
      await notifyMilestone(
        monitor.symbol,
        currentPrice,
        monitor.entryPrice,
        currentMilestone
      );
      updateMonitor(monitor.address, { lastNotifiedMilestone: currentMilestone });
      logger.info(
        { symbol: monitor.symbol, milestone: currentMilestone, price: currentPrice },
        "Buyback monitor milestone reached"
      );
    }
  }

  // ── Buyback logic (downward) ───────────────────────────────────
  if (monitor.entryPrice > 0 && currentPrice < monitor.entryPrice && usdcPerBuy > 0) {
    const dropPercent = ((monitor.entryPrice - currentPrice) / monitor.entryPrice) * 100;
    const dropLevel = Math.floor(dropPercent / buybackPct);

    if (dropLevel > lastBuybackLevel) {
      // Check if budget allows
      if (usdcSpent >= totalBudget) {
        logger.info(
          { symbol: monitor.symbol, usdcSpent, totalBudget },
          "Buyback budget exhausted — skipping"
        );
        return;
      }

      // Execute buyback
      const buyAmount = Math.min(usdcPerBuy, totalBudget - usdcSpent);

      logger.info(
        {
          symbol: monitor.symbol,
          dropPercent: dropPercent.toFixed(1),
          dropLevel,
          lastBuybackLevel,
          buyAmount,
        },
        "BUYBACK triggered — buying token"
      );

      const result = await buyToken(monitor.address as Address, buyAmount.toString());

      usdcSpent += buyAmount;
      lastBuybackLevel = dropLevel;

      const remaining = Math.max(0, totalBudget - usdcSpent);

      await notifyBuyback(
        monitor.symbol,
        currentPrice,
        monitor.entryPrice,
        dropPercent,
        buyAmount,
        remaining,
        result.txHash ?? "",
        result.success
      );

      updateMonitor(monitor.address, {
        usdcSpent,
        lastBuybackLevel,
      });

      if (usdcSpent >= totalBudget) {
        await notifyBudgetExhausted(monitor.symbol, usdcSpent);
        logger.info({ symbol: monitor.symbol }, "Buyback budget exhausted");
      }

      if (!result.success) {
        logger.error(
          { symbol: monitor.symbol, error: result.error },
          "Buyback buy FAILED"
        );
      }
    }
  }
}

// ── ETH balance check ──────────────────────────────────────────────

async function checkEthBalance(): Promise<void> {
  try {
    const ethBalance = await getEthBalance();
    const ethFormatted = await getEthBalanceFormatted();

    if (ethBalance < config.ethWarnThreshold) {
      const now = Date.now();
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
 * Start the price monitoring loop (30s ticks by default).
 */
export function startMonitorLoop(): void {
  if (tickInterval) return;

  const intervalMs = config.monitorIntervalSec * 1000;

  logger.info(
    { intervalSec: config.monitorIntervalSec },
    "Starting price monitor loop"
  );

  // Fire immediately, then on interval
  tick().catch((err) => logger.error({ err }, "Initial tick failed"));

  tickInterval = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Tick error"));
  }, intervalMs);
}

/**
 * Stop the monitoring loop gracefully.
 */
export function stopMonitorLoop(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info("Monitor loop stopped");
  }
}
