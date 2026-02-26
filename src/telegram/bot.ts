import { Bot, type Context } from "grammy";
import { formatUnits, type Address } from "viem";
import { config, USDC_DECIMALS } from "../config/index.js";
import {
  getEthBalanceFormatted,
  getUsdcBalanceFormatted,
  getWalletAddress,
} from "../chain/wallet.js";
import {
  getPositions,
  getHistory,
  isTradingPaused,
  setPaused,
  forceSell,
  forceSellByAddress,
  addToBlacklist,
  getMonitors,
  getActiveMonitors,
  addMonitor,
  removeMonitor,
  clearAllMonitors,
  type MonitoredToken,
  type TradeHistoryEntry,
} from "../positions/manager.js";
import { getTokenInfo } from "../scanner/dexscreener.js";
import { logger } from "../utils/logger.js";

// ── Bot instance ───────────────────────────────────────────────────

let bot: Bot;
let authorizedChatId: string;

/**
 * Create and configure the Telegram bot.
 * Call this after loadConfig().
 */
export function createBot(): Bot {
  authorizedChatId = config.telegramChatId;
  bot = new Bot(config.telegramBotToken);

  // ── Middleware: auth guard ─────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== authorizedChatId) {
      await ctx.reply("⛔ Unauthorized. This bot is private.");
      return;
    }
    await next();
  });

  // ── Commands ──────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const monitors = getActiveMonitors();
    const monitorLine = monitors.length > 0
      ? `\n\n📡 <b>Active monitors:</b> ${monitors.map((m) => m.symbol).join(", ")}`
      : "\n\nNo active monitors.";

    await ctx.reply(
      `🐾 <b>OpenClaw Trader</b> is running!${monitorLine}\n\n` +
        `<b>How to use:</b>\n` +
        `Send a message in this format to start monitoring:\n` +
        `<code>&lt;contract_address&gt; &lt;stop_loss_price&gt;</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>0x1234...abcd 0.005</code>\n\n` +
        `<b>Commands:</b>\n` +
        `/status — Overview (balances, monitors)\n` +
        `/monitors — List all active monitors\n` +
        `/balance — ETH + USDC balances\n` +
        `/history — Last 10 trades\n` +
        `/stop &lt;address&gt; — Stop monitoring a token\n` +
        `/stopall — Stop all monitors\n` +
        `/sell &lt;address&gt; — Force-sell a token\n` +
        `/pause — Pause all monitoring\n` +
        `/resume — Resume monitoring`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("status", handleStatus);
  bot.command("monitors", handleMonitors);
  bot.command("balance", handleBalance);
  bot.command("history", handleHistory);
  bot.command("pause", handlePause);
  bot.command("resume", handleResume);
  bot.command("sell", handleSell);
  bot.command("stop", handleStop);
  bot.command("stopall", handleStopAll);

  // ── Text message handler: parse "<address> <stop_loss_price>" ──
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text?.trim() ?? "";
    if (text.startsWith("/")) return;

    // Expected format: <contract_address> <stop_loss_price>
    const match = text.match(/^(0x[a-fA-F0-9]{40})\s+([\d.]+)$/);
    if (!match) {
      await ctx.reply(
        `❌ Invalid format.\n\n` +
          `Please send in this format:\n` +
          `<code>&lt;contract_address&gt; &lt;stop_loss_price&gt;</code>\n\n` +
          `Example:\n<code>0x1234abcd...5678 0.005</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const contractAddress = match[1];
    const stopLossPrice = parseFloat(match[2]);

    if (isNaN(stopLossPrice) || stopLossPrice <= 0) {
      await ctx.reply("❌ Invalid stop-loss price. Please provide a positive number.");
      return;
    }

    // Fetch token info
    await ctx.reply("⏳ Looking up token...");
    const info = await getTokenInfo(contractAddress);
    if (!info) {
      await ctx.reply(
        `❌ Could not find token <code>${contractAddress}</code> on Base.\nPlease verify the contract address.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (info.priceUsd <= 0) {
      await ctx.reply(`❌ Could not get current price for <b>${info.symbol}</b>. Try again later.`, { parse_mode: "HTML" });
      return;
    }

    if (stopLossPrice >= info.priceUsd) {
      await ctx.reply(
        `⚠️ Stop-loss price ($${stopLossPrice}) is above or equal to current price ($${info.priceUsd.toPrecision(6)}).\n` +
        `This would trigger an immediate sell. Please set a stop-loss below current price.`,
      );
      return;
    }

    // Add the monitor
    const monitor: MonitoredToken = {
      address: info.address,
      symbol: info.symbol,
      name: info.name,
      stopLossPrice,
      entryPrice: info.priceUsd,
      lastNotifiedMilestone: 0,
      active: true,
      dexScreenerUrl: info.dexScreenerUrl,
      addedAt: Date.now(),
    };

    addMonitor(monitor);

    const slPercent = ((info.priceUsd - stopLossPrice) / info.priceUsd * 100).toFixed(1);

    await ctx.reply(
      `✅ <b>Monitoring ${info.symbol}</b>\n\n` +
        `📍 Address: <code>${info.address}</code>\n` +
        `💵 Current price: $${info.priceUsd.toPrecision(6)}\n` +
        `🛑 Stop-loss: $${stopLossPrice} (${slPercent}% below current)\n` +
        `📊 Milestones: every +25% from entry\n` +
        `⏱️ Checking every ${config.monitorIntervalSec}s\n\n` +
        `${config.dryRun ? "🔧 <b>DRY RUN MODE</b> — sells won't execute" : "🔴 <b>LIVE MODE</b> — will auto-sell on stop-loss"}`,
      { parse_mode: "HTML" }
    );
  });

  // Register error handler
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, "Telegram bot error");
  });

  return bot;
}

/** Get the bot instance */
export function getBot(): Bot {
  return bot;
}

// ── Notification helpers (proactive messages) ──────────────────────

/**
 * Send a message to the authorized chat.
 */
export async function notify(message: string, parseMode?: "HTML" | "MarkdownV2"): Promise<void> {
  try {
    await bot.api.sendMessage(authorizedChatId, message, {
      parse_mode: parseMode,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send Telegram notification");
  }
}

/** Notify about a stop-loss trigger */
export async function notifyStopLossHit(
  symbol: string,
  currentPrice: number,
  stopLossPrice: number,
  lossPercent: number,
  txHash: string,
  sellSuccess: boolean
): Promise<void> {
  const basescanLink = txHash ? `\n🔗 <a href="https://basescan.org/tx/${txHash}">View on BaseScan</a>` : "";
  const status = sellSuccess ? "✅ Sold successfully" : "❌ Sell FAILED — will retry";
  await notify(
    `🛑 <b>STOP-LOSS HIT: ${symbol}</b>\n\n` +
      `💵 Price: $${currentPrice.toPrecision(6)}\n` +
      `🎯 Stop-loss was: $${stopLossPrice}\n` +
      `📉 Change from entry: ${lossPercent >= 0 ? "+" : ""}${lossPercent.toFixed(1)}%\n` +
      `${status}` +
      basescanLink,
    "HTML"
  );
}

/** Notify about a 25% price milestone */
export async function notifyMilestone(
  symbol: string,
  currentPrice: number,
  entryPrice: number,
  milestonePercent: number
): Promise<void> {
  const gainPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1);
  await notify(
    `🚀 <b>${symbol} +${milestonePercent}% MILESTONE</b>\n\n` +
      `💵 Current price: $${currentPrice.toPrecision(6)}\n` +
      `📈 Entry price: $${entryPrice.toPrecision(6)}\n` +
      `📊 Gain: +${gainPercent}%`,
    "HTML"
  );
}

/** Notify low ETH warning */
export async function notifyLowEth(balance: string): Promise<void> {
  await notify(
    `⚠️ <b>LOW ETH WARNING</b>\n\n` +
      `Current balance: ${balance} ETH\n\n` +
      `Please top up ETH on Base to continue trading.`,
    "HTML"
  );
}

/** Notify about an error */
export async function notifyError(context: string, error: string): Promise<void> {
  await notify(
    `❌ <b>ERROR</b>: ${context}\n\n<code>${escapeHtml(error.slice(0, 500))}</code>`,
    "HTML"
  );
}

/** Notify about a completed sell */
export async function notifySell(
  symbol: string,
  usdcReceived: string,
  price: number,
  profitPercent: number,
  reason: string,
  txHash: string
): Promise<void> {
  const emoji = profitPercent >= 0 ? "🟢" : "🔴";
  const basescanLink = `https://basescan.org/tx/${txHash}`;
  const usdcFormatted = parseFloat(formatUnits(BigInt(usdcReceived), USDC_DECIMALS)).toFixed(2);
  await notify(
    `${emoji} <b>SELL ${symbol}</b> (${reason})\n` +
      `💰 Received: $${usdcFormatted} USDC\n` +
      `💵 Price: $${price.toPrecision(6)}\n` +
      `📊 P&L: ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(2)}%\n` +
      `🔗 <a href="${basescanLink}">View on BaseScan</a>`,
    "HTML"
  );
}

// ── Command handlers ───────────────────────────────────────────────

async function handleStatus(ctx: Context): Promise<void> {
  try {
    const [ethBal, usdcBal] = await Promise.all([
      getEthBalanceFormatted(),
      getUsdcBalanceFormatted(),
    ]);
    const monitors = getActiveMonitors();
    const paused = isTradingPaused();

    let monitorBlock: string;
    if (monitors.length === 0) {
      monitorBlock = "📡 No active monitors.\nSend <code>&lt;address&gt; &lt;price&gt;</code> to start.\n";
    } else {
      monitorBlock = "📡 <b>Active Monitors:</b>\n" +
        monitors.map((m) => {
          const slPercent = ((m.entryPrice - m.stopLossPrice) / m.entryPrice * 100).toFixed(1);
          return `  • <b>${m.symbol}</b> — SL: $${m.stopLossPrice} (${slPercent}% below entry $${m.entryPrice.toPrecision(6)})`;
        }).join("\n") + "\n";
    }

    await ctx.reply(
      `📊 <b>OpenClaw Status</b>\n\n` +
        `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
        `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n\n` +
        monitorBlock + "\n" +
        `⏱️ Check interval: ${config.monitorIntervalSec}s\n` +
        `Status: ${paused ? "⏸️ Paused" : "🟢 Active"}\n` +
        `${config.dryRun ? "🔧 DRY RUN" : "🔴 LIVE"}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.error({ err }, "Error in /status");
    await ctx.reply("❌ Failed to fetch status. Check logs.");
  }
}

async function handleMonitors(ctx: Context): Promise<void> {
  const monitors = getMonitors();
  if (monitors.length === 0) {
    await ctx.reply("📭 No active monitors.\n\nSend <code>&lt;address&gt; &lt;stop_loss_price&gt;</code> to start monitoring.", { parse_mode: "HTML" });
    return;
  }

  let msg = "📡 <b>Active Monitors</b>\n\n";
  for (const m of monitors) {
    const slPercent = m.entryPrice > 0
      ? ((m.entryPrice - m.stopLossPrice) / m.entryPrice * 100).toFixed(1)
      : "?";
    const status = m.active ? "🟢 Active" : "❌ Inactive";
    const held = timeSince(m.addedAt);

    msg +=
      `<b>${m.symbol}</b> ${status}\n` +
      `   📍 <code>${m.address}</code>\n` +
      `   💵 Entry: $${m.entryPrice.toPrecision(6)}\n` +
      `   🛑 SL: $${m.stopLossPrice} (${slPercent}% below)\n` +
      `   📊 Last milestone: +${m.lastNotifiedMilestone}%\n` +
      `   ⏱️ Monitoring for: ${held}\n\n`;
  }

  msg += `Use /stop &lt;address&gt; to remove a monitor.`;
  await ctx.reply(msg, { parse_mode: "HTML" });
}

async function handleBalance(ctx: Context): Promise<void> {
  try {
    const [ethBal, usdcBal] = await Promise.all([
      getEthBalanceFormatted(),
      getUsdcBalanceFormatted(),
    ]);
    const addr = getWalletAddress();
    await ctx.reply(
      `💰 <b>Wallet Balances</b>\n\n` +
        `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
        `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n` +
        `📍 Address: <code>${addr}</code>\n` +
        `🔗 <a href="https://basescan.org/address/${addr}">BaseScan</a>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await ctx.reply("❌ Failed to fetch balances.");
  }
}

async function handleHistory(ctx: Context): Promise<void> {
  const entries = getHistory(10);
  if (entries.length === 0) {
    await ctx.reply("📭 No trade history yet.");
    return;
  }

  let msg = "📜 <b>Recent Trades</b>\n\n";
  for (const e of entries.reverse()) {
    const emoji = e.type === "buy" ? "🟢 BUY" : "🔴 SELL";
    const time = new Date(e.timestamp).toLocaleString("en-US", { timeZone: "UTC" });
    const pl =
      e.profitPercent != null
        ? ` | P&L: ${e.profitPercent >= 0 ? "+" : ""}${e.profitPercent.toFixed(1)}%`
        : "";
    const reason = e.reason ? ` (${e.reason})` : "";
    msg += `${emoji} <b>${e.tokenSymbol}</b>${reason}\n   $${e.usdcAmount} USDC @ $${e.price.toPrecision(4)}${pl}\n   ${time}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
}

async function handlePause(ctx: Context): Promise<void> {
  setPaused(true);
  await ctx.reply("⏸️ Monitoring has been <b>PAUSED</b>. Use /resume to restart.", {
    parse_mode: "HTML",
  });
}

async function handleResume(ctx: Context): Promise<void> {
  setPaused(false);
  await ctx.reply("▶️ Monitoring has been <b>RESUMED</b>.", { parse_mode: "HTML" });
}

async function handleSell(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    const monitors = getActiveMonitors();
    if (monitors.length === 0) {
      await ctx.reply("📭 No monitored tokens to sell.");
      return;
    }
    let msg = "Usage: /sell <token_address>\n\nMonitored tokens:\n";
    for (const m of monitors) {
      msg += `• ${m.symbol}: <code>${m.address}</code>\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const tokenAddress = parts[1].trim();
  await ctx.reply(`⏳ Selling all ${tokenAddress}...`);

  // Try position-based sell first
  const posResult = await forceSell(tokenAddress);
  if (posResult) {
    if (posResult.result.success) {
      const pl =
        ((posResult.position.currentPrice - posResult.position.entryPrice) /
          posResult.position.entryPrice) *
        100;
      await ctx.reply(
        `✅ Sold <b>${posResult.position.tokenSymbol}</b>\n` +
          `P&L: ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%\n` +
          `TX: ${posResult.result.txHash ?? "N/A"}`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(`❌ Sell failed: ${posResult.result.error}`);
    }
    return;
  }

  // Try monitor-based sell
  const monitor = getMonitors().find(
    (m) => m.address.toLowerCase() === tokenAddress.toLowerCase()
  );
  const symbol = monitor?.symbol ?? "token";
  const result = await forceSellByAddress(tokenAddress, symbol, "manual");
  if (result.success) {
    // Also remove the monitor
    removeMonitor(tokenAddress);
    await ctx.reply(
      `✅ Sold all <b>${symbol}</b>\nTX: ${result.txHash ?? "N/A"}`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(`❌ Sell failed: ${result.error}`);
  }
}

async function handleStop(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    const monitors = getActiveMonitors();
    if (monitors.length === 0) {
      await ctx.reply("📭 No active monitors to stop.");
      return;
    }
    let msg = "Usage: /stop <token_address>\n\nActive monitors:\n";
    for (const m of monitors) {
      msg += `• ${m.symbol}: <code>${m.address}</code>\n`;
    }
    msg += "\nOr use /stopall to stop all monitors.";
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const tokenAddress = parts[1].trim();
  const removed = removeMonitor(tokenAddress);
  if (removed) {
    await ctx.reply(`⏹️ Stopped monitoring <b>${removed.symbol}</b>`, { parse_mode: "HTML" });
  } else {
    await ctx.reply(`❌ No monitor found for <code>${tokenAddress}</code>`, { parse_mode: "HTML" });
  }
}

async function handleStopAll(ctx: Context): Promise<void> {
  const monitors = getActiveMonitors();
  if (monitors.length === 0) {
    await ctx.reply("📭 No active monitors to stop.");
    return;
  }
  const count = monitors.length;
  clearAllMonitors();
  await ctx.reply(`⏹️ Stopped all <b>${count}</b> monitor(s).`, { parse_mode: "HTML" });
}

// ── Utilities ──────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function timeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
