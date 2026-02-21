import { Bot, type Context } from "grammy";
import type { Address } from "viem";
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
  addToBlacklist,
  computeStopPrice,
  type Position,
  type TradeHistoryEntry,
} from "../positions/manager.js";
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
    await ctx.reply(
      `🐾 *OpenClaw Trader* is running\\!\n\n` +
        `Commands:\n` +
        `/status — Overview \\(balances \\+ positions\\)\n` +
        `/portfolio — Detailed positions\n` +
        `/balance — ETH \\+ USDC balances\n` +
        `/history — Last 10 trades\n` +
        `/pause — Pause autonomous trading\n` +
        `/resume — Resume trading\n` +
        `/sell \\<address\\> — Force\\-sell a position\n` +
        `/blacklist \\<address\\> — Blacklist a token`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("status", handleStatus);
  bot.command("portfolio", handlePortfolio);
  bot.command("balance", handleBalance);
  bot.command("history", handleHistory);
  bot.command("pause", handlePause);
  bot.command("resume", handleResume);
  bot.command("sell", handleSell);
  bot.command("blacklist", handleBlacklist);

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

/** Notify about a completed buy */
export async function notifyBuy(
  symbol: string,
  usdcAmount: string,
  price: number,
  txHash: string
): Promise<void> {
  const basescanLink = `https://basescan.org/tx/${txHash}`;
  await notify(
    `🟢 <b>BUY ${symbol}</b>\n` +
      `💰 Spent: $${usdcAmount} USDC\n` +
      `💵 Price: $${price.toPrecision(6)}\n` +
      `🔗 <a href="${basescanLink}">View on BaseScan</a>`,
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
  await notify(
    `${emoji} <b>SELL ${symbol}</b> (${reason})\n` +
      `💰 Received: $${usdcReceived} USDC\n` +
      `💵 Price: $${price.toPrecision(6)}\n` +
      `📊 P&L: ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(2)}%\n` +
      `🔗 <a href="${basescanLink}">View on BaseScan</a>`,
    "HTML"
  );
}

/** Notify low ETH warning */
export async function notifyLowEth(balance: string): Promise<void> {
  await notify(
    `⚠️ <b>LOW ETH WARNING</b>\n\n` +
      `Current balance: ${balance} ETH\n` +
      `Threshold: ${config.ethWarnThreshold.toString()} wei\n\n` +
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

/** Notify about a stop-loss trigger */
export async function notifyStopLoss(
  symbol: string,
  trailPercent: number,
  profitPercent: number,
  sellSuccess: boolean
): Promise<void> {
  const status = sellSuccess ? "✅ Sold successfully" : "❌ Sell failed — will retry";
  await notify(
    `🛑 <b>STOP-LOSS: ${symbol}</b>\n` +
      `📉 Trail: ${trailPercent}% below peak\n` +
      `📊 Peak profit was: ${profitPercent.toFixed(1)}%\n` +
      `${status}`,
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
    const positions = getPositions();
    const paused = isTradingPaused();

    const positionSummary =
      positions.length === 0
        ? "No open positions"
        : positions
            .map((p) => {
              const pl = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
              const emoji = pl >= 0 ? "🟢" : "🔴";
              return `${emoji} ${p.tokenSymbol}: $${p.currentPrice.toPrecision(4)} (${pl >= 0 ? "+" : ""}${pl.toFixed(1)}%)`;
            })
            .join("\n");

    await ctx.reply(
      `📊 <b>OpenClaw Status</b>\n\n` +
        `💎 ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
        `💵 USDC: $${parseFloat(usdcBal).toFixed(2)}\n` +
        `📁 Positions: ${positions.length}/${config.maxPositions}\n` +
        `${paused ? "⏸️ Trading PAUSED" : "▶️ Trading ACTIVE"}\n\n` +
        `<b>Positions:</b>\n${positionSummary}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.error({ err }, "Error in /status");
    await ctx.reply("❌ Failed to fetch status. Check logs.");
  }
}

async function handlePortfolio(ctx: Context): Promise<void> {
  try {
    const positions = getPositions();
    if (positions.length === 0) {
      await ctx.reply("📭 No open positions.");
      return;
    }

    let msg = "📋 <b>Portfolio Details</b>\n\n";
    for (const p of positions) {
      const { stopPrice, trailPercent, profitPercent } = computeStopPrice(p);
      const currentPl = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
      const holdTime = timeSince(p.entryTimestamp);
      const emoji = currentPl >= 0 ? "🟢" : "🔴";

      msg +=
        `${emoji} <b>${p.tokenSymbol}</b>\n` +
        `   Entry: $${p.entryPrice.toPrecision(4)}\n` +
        `   Current: $${p.currentPrice.toPrecision(4)}\n` +
        `   Peak: $${p.highestPrice.toPrecision(4)}\n` +
        `   P&L: ${currentPl >= 0 ? "+" : ""}${currentPl.toFixed(2)}%\n` +
        `   Stop: $${stopPrice.toPrecision(4)} (${trailPercent}% trail)\n` +
        `   Invested: $${p.usdcInvested}\n` +
        `   Held: ${holdTime}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Error in /portfolio");
    await ctx.reply("❌ Failed to fetch portfolio.");
  }
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
  await ctx.reply("⏸️ Trading has been <b>PAUSED</b>. Use /resume to restart.", {
    parse_mode: "HTML",
  });
}

async function handleResume(ctx: Context): Promise<void> {
  setPaused(false);
  await ctx.reply("▶️ Trading has been <b>RESUMED</b>.", { parse_mode: "HTML" });
}

async function handleSell(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    // Show list of positions to sell
    const positions = getPositions();
    if (positions.length === 0) {
      await ctx.reply("📭 No positions to sell.");
      return;
    }
    let msg = "Usage: /sell <token_address>\n\nOpen positions:\n";
    for (const p of positions) {
      msg += `• ${p.tokenSymbol}: <code>${p.tokenAddress}</code>\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const tokenAddress = parts[1].trim();
  await ctx.reply(`⏳ Selling ${tokenAddress}...`);

  const result = await forceSell(tokenAddress);
  if (!result) {
    await ctx.reply("❌ No open position found for that token.");
    return;
  }

  if (result.result.success) {
    const pl =
      ((result.position.currentPrice - result.position.entryPrice) /
        result.position.entryPrice) *
      100;
    await ctx.reply(
      `✅ Sold <b>${result.position.tokenSymbol}</b>\n` +
        `P&L: ${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%\n` +
        `TX: ${result.result.txHash ?? "N/A"}`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(`❌ Sell failed: ${result.result.error}`);
  }
}

async function handleBlacklist(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply("Usage: /blacklist <token_address>");
    return;
  }

  const tokenAddress = parts[1].trim();
  addToBlacklist(tokenAddress);
  await ctx.reply(`🚫 Token <code>${tokenAddress}</code> has been blacklisted.`, {
    parse_mode: "HTML",
  });
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
