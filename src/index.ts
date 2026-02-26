import { loadConfig, config } from "./config/index.js";
import { initWallet, getWalletAddress, getEthBalanceFormatted, getUsdcBalanceFormatted } from "./chain/wallet.js";
import { initPositionManager, saveAllState, getActiveMonitors } from "./positions/manager.js";
import { createBot, notify } from "./telegram/bot.js";
import { startMonitorLoop, stopMonitorLoop } from "./core/orchestrator.js";
import { startApiServer, stopApiServer, setStartingBalance } from "./api/server.js";
import { logger } from "./utils/logger.js";

// ── Banner ─────────────────────────────────────────────────────────
function printBanner(): void {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     🐾  OpenClaw Trader  v2.0.0      ║
  ║   Stop-Loss Monitor · Base Chain      ║
  ╚═══════════════════════════════════════╝
  `);
}

// ── Main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  printBanner();

  // 1. Load environment configuration
  logger.info("Loading configuration...");
  loadConfig();
  logger.info(
    {
      maxPositions: config.maxPositions,
      monitorIntervalSec: config.monitorIntervalSec,
      dryRun: config.dryRun,
    },
    "Configuration loaded"
  );

  // 2. Initialize wallet
  logger.info("Initializing wallet...");
  initWallet();
  const address = getWalletAddress();
  const [ethBal, usdcBal] = await Promise.all([
    getEthBalanceFormatted(),
    getUsdcBalanceFormatted(),
  ]);
  logger.info(
    { address, eth: ethBal, usdc: usdcBal },
    "Wallet connected"
  );

  // 3. Initialize position manager (loads monitors from disk)
  logger.info("Loading state...");
  initPositionManager();
  const monitors = getActiveMonitors();
  logger.info({ activeMonitors: monitors.length }, "State loaded");

  // 4. Start public API server
  setStartingBalance(parseFloat(usdcBal));
  startApiServer(config.apiPort);
  logger.info({ port: config.apiPort }, "Public API server started");

  // 5. Start Telegram bot
  logger.info("Starting Telegram bot...");
  const bot = createBot();
  bot.start({
    onStart: () => {
      logger.info("Telegram bot started (long-polling)");
    },
  });

  // 6. Send startup notification
  const monitorsList = monitors.length > 0
    ? `📡 Active monitors: ${monitors.map((m) => m.symbol).join(", ")}`
    : `📡 No active monitors — send a contract address + stop-loss price to start`;

  await notify(
    `🐾 <b>OpenClaw Trader Started</b>\n\n` +
      `📍 Wallet: <code>${address}</code>\n` +
      `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
      `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n` +
      `${monitorsList}\n` +
      `⏱️ Check interval: ${config.monitorIntervalSec}s\n` +
      `${config.dryRun ? "🔧 <b>DRY RUN MODE</b>" : "🔴 <b>LIVE TRADING</b>"}`,
    "HTML"
  );

  // 7. Start the price monitor loop
  logger.info("Starting price monitor loop...");
  startMonitorLoop();

  logger.info("═══════════════════════════════════════════");
  logger.info("OpenClaw Trader is fully operational!");
  logger.info("═══════════════════════════════════════════");
}

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down...");

  stopMonitorLoop();
  stopApiServer();
  saveAllState();

  notify("🛑 <b>OpenClaw Trader shutting down</b> (" + signal + ")", "HTML")
    .catch(() => {})
    .finally(() => {
      logger.info("Goodbye! 🐾");
      process.exit(0);
    });

  setTimeout(() => {
    logger.warn("Force exiting after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" || err.code === "ECONNRESET") {
    logger.warn({ err }, "Non-fatal uncaught exception (continuing)");
    return;
  }
  logger.fatal({ err }, "Uncaught exception");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

// ── Start ──────────────────────────────────────────────────────────
main().catch((err) => {
  logger.fatal({ err }, "Failed to start OpenClaw Trader");
  process.exit(1);
});
