import { type Address } from "viem";
import { config } from "../config/index.js";
import {
  getEthBalance,
  getEthBalanceFormatted,
} from "../chain/wallet.js";
import { getTokenPrice } from "../scanner/dexscreener.js";
import {
  getActiveMonitors,
  updateMonitor,
  removeMonitor,
  forceSellByAddress,
  type MonitoredToken,
} from "../positions/manager.js";
import {
  notify,
  notifyStopLossHit,
  notifyError,
  notifyLowEth,
  notifyMilestone,
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
 * Process a single monitored token:
 *  - Fetch price
 *  - Check stop-loss
 *  - Check 25% milestones
 */
async function processMonitor(monitor: MonitoredToken): Promise<void> {
  const currentPrice = await getTokenPrice(monitor.address as Address);
  if (currentPrice === null) {
    logger.warn({ token: monitor.address, symbol: monitor.symbol }, "Could not fetch price — skipping");
    return;
  }

  logger.debug(
    {
      symbol: monitor.symbol,
      currentPrice,
      stopLoss: monitor.stopLossPrice,
      entryPrice: monitor.entryPrice,
      lastMilestone: monitor.lastNotifiedMilestone,
    },
    "Price check"
  );

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
      // Deactivate and remove the monitor
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
    // Calculate which 25% milestone we're at (25, 50, 75, 100, 125, etc.)
    const currentMilestone = Math.floor(gainPercent / 25) * 25;

    if (currentMilestone > 0 && currentMilestone > monitor.lastNotifiedMilestone) {
      // Notify for this milestone
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
