import { loadConfig, config } from "./config/index.js";
import { initWallet, getWalletAddress, getEthBalanceFormatted, getUsdcBalanceFormatted } from "./chain/wallet.js";
import { initPositionManager, saveAllState, getPositions, getFocusedToken, setFocusedToken } from "./positions/manager.js";
import { getTokenInfo } from "./scanner/dexscreener.js";
import { createBot, notify } from "./telegram/bot.js";
import { startFocusedTradingLoop, stopFocusedTradingLoop } from "./core/orchestrator.js";
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
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      reentryCooldownSec: config.reentryCooldownSec,
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

  // 3a. Seed focused token from FOCUSED_TOKEN env var if not already set
  if (config.focusedToken && !getFocusedToken()) {
    logger.info({ address: config.focusedToken }, "Seeding focused token from env var...");
    const info = await getTokenInfo(config.focusedToken);
    if (info) {
      setFocusedToken({
        address: info.address,
        symbol: info.symbol,
        name: info.name,
        stopLossPercent: config.stopLossPercent,
        takeProfitPercent: config.takeProfitPercent,
        active: true,
        dexScreenerUrl: info.dexScreenerUrl,
      });
      logger.info({ symbol: info.symbol }, "Focused token set from env");
    } else {
      logger.warn({ address: config.focusedToken }, "Could not resolve FOCUSED_TOKEN address");
    }
  }

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
  const focusedToken = getFocusedToken();
  await notify(
    `🐾 <b>OpenClaw Trader Started</b>\n\n` +
      `📍 Wallet: <code>${address}</code>\n` +
      `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
      `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n` +
      `📁 Open positions: ${positions.length}\n` +
      (focusedToken
        ? `🎯 Focused: <b>${focusedToken.symbol}</b> (SL ${focusedToken.stopLossPercent}% / TP ${focusedToken.takeProfitPercent}%)\n`
        : `🎯 No focused token \u2014 send a contract address to start\n`) +
      `🤖 AI: ${isAIEnabled() ? "Claude ON" : "OFF (no API key)"}\n` +
      `${config.dryRun ? "🔧 <b>DRY RUN MODE</b>" : "🔴 <b>LIVE TRADING</b>"}`,
    "HTML"
  );

  // 6. Start the focused trading loop
  logger.info("Starting focused trading loop...");
  startFocusedTradingLoop();

  logger.info("═══════════════════════════════════════════");
  logger.info("OpenClaw Trader is fully operational!");
  logger.info("═══════════════════════════════════════════");
}

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down...");

  stopFocusedTradingLoop();
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

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  // Don't crash the whole bot for recoverable errors like EADDRINUSE
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
