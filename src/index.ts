import { loadConfig, config } from "./config/index.js";
import { initWallet, getWalletAddress, getEthBalanceFormatted, getUsdcBalanceFormatted } from "./chain/wallet.js";
import { initPositionManager, saveAllState, getPositions } from "./positions/manager.js";
import { createBot, notify } from "./telegram/bot.js";
import { startOrchestrator, stopOrchestrator } from "./core/orchestrator.js";
import { initAI, isAIEnabled } from "./ai/analyst.js";
import { startApiServer, stopApiServer, setStartingBalance } from "./api/server.js";
import { logger } from "./utils/logger.js";

// ── Banner ─────────────────────────────────────────────────────────
function printBanner(): void {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     🐾  OpenClaw Trader  v1.0.0      ║
  ║   Autonomous Base Chain Trading Bot   ║
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
      scanInterval: config.scanIntervalMin,
      maxPositions: config.maxPositions,
      tradePercent: config.tradePercent,
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

  // 3. Initialize position manager
  logger.info("Loading positions...");
  initPositionManager();
  const positions = getPositions();
  logger.info({ openPositions: positions.length }, "Positions loaded");

  // 3b. Initialize AI analyst
  logger.info("Initializing AI analyst...");
  initAI();
  logger.info({ aiEnabled: isAIEnabled() }, "AI analyst status");

  // 3c. Start public API server
  setStartingBalance(parseFloat(usdcBal));
  startApiServer(config.apiPort);
  logger.info({ port: config.apiPort }, "Public API server started");

  // 4. Start Telegram bot
  logger.info("Starting Telegram bot...");
  const bot = createBot();
  bot.start({
    onStart: () => {
      logger.info("Telegram bot started (long-polling)");
    },
  });

  // 5. Send startup notification
  await notify(
    `🐾 <b>OpenClaw Trader Started</b>\n\n` +
      `📍 Wallet: <code>${address}</code>\n` +
      `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
      `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n` +
      `📁 Open positions: ${positions.length}/${config.maxPositions}\n` +
      `⏱️ Scan interval: ${config.scanIntervalMin}min\n` +
      `🤖 AI: ${isAIEnabled() ? "Claude ON" : "OFF (score-only)"}\n` +
      `${config.dryRun ? "🔧 <b>DRY RUN MODE</b>" : "🔴 <b>LIVE TRADING</b>"}`,
    "HTML"
  );

  // 6. Start the trading orchestrator
  logger.info("Starting trading orchestrator...");
  startOrchestrator();

  logger.info("═══════════════════════════════════════════");
  logger.info("OpenClaw Trader is fully operational!");
  logger.info("═══════════════════════════════════════════");
}

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down...");

  stopOrchestrator();
  stopApiServer();
  saveAllState();

  notify("🛑 <b>OpenClaw Trader shutting down</b> (" + signal + ")", "HTML")
    .catch(() => {})
    .finally(() => {
      logger.info("Goodbye! 🐾");
      process.exit(0);
    });

  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => {
    logger.warn("Force exiting after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
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
