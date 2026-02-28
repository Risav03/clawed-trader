import { Bot, type Context } from "grammy";
import { formatUnits, type Address } from "viem";
import { config, USDC_DECIMALS } from "../config/index.js";
import {
  getEthBalanceFormatted,
  getUsdcBalance,
  getUsdcBalanceFormatted,
  getWalletAddress,
} from "../chain/wallet.js";
import {
  getPositions,
  getPosition,
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
  type MonitorType,
  type TradeHistoryEntry,
} from "../positions/manager.js";
import { buyToken } from "../swap/executor.js";
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
        `/simple &lt;address&gt; &lt;stop-loss&gt; &lt;notify%&gt; — Monitor with custom notify interval\n` +
        `/buyback &lt;address&gt; &lt;notify%&gt; &lt;usdc&gt; &lt;buyback%&gt; — Monitor + auto buy on dips\n` +
        `/status — Overview (balances, monitors)\n` +
        `/monitors — List all active monitors\n` +
        `/balance — ETH + USDC balances\n` +
        `/history — Last 10 trades\n` +
        `/stop — Stop all monitors (or /stop &lt;address&gt; for one)\n` +
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
  bot.command("simple", handleSimple);
  bot.command("buyback", handleBuyback);

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

/** Notify about a price milestone */
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

/** Notify about a buyback execution */
export async function notifyBuyback(
  symbol: string,
  currentPrice: number,
  entryPrice: number,
  dropPercent: number,
  usdcSpent: number,
  usdcRemaining: number,
  txHash: string,
  success: boolean
): Promise<void> {
  const basescanLink = txHash ? `\n🔗 <a href="https://basescan.org/tx/${txHash}">View on BaseScan</a>` : "";
  const status = success ? "✅ Buy executed" : "❌ Buy FAILED";
  await notify(
    `🔄 <b>BUYBACK: ${symbol}</b>\n\n` +
      `📉 Drop from entry: -${dropPercent.toFixed(1)}%\n` +
      `💵 Current price: $${currentPrice.toPrecision(6)}\n` +
      `📈 Entry price: $${entryPrice.toPrecision(6)}\n` +
      `${status}\n` +
      `💰 Spent this buy: $${usdcSpent.toFixed(2)}\n` +
      `💼 Budget remaining: $${usdcRemaining.toFixed(2)}` +
      basescanLink,
    "HTML"
  );
}

/** Notify that buyback budget is exhausted */
export async function notifyBudgetExhausted(
  symbol: string,
  totalSpent: number
): Promise<void> {
  await notify(
    `💸 <b>${symbol} BUYBACK BUDGET EXHAUSTED</b>\n\n` +
      `Total spent: $${totalSpent.toFixed(2)} USDC\n` +
      `No more buybacks will execute. Use /stop to remove this monitor.`,
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
          const monitorType = m.type ?? "standard";
          const typeIcon = monitorType === "standard" ? "📋" : monitorType === "simple" ? "🔍" : "🔄";
          if (monitorType === "buyback") {
            const spent = m.usdcSpent ?? 0;
            const budget = m.totalUsdcBudget ?? 0;
            return `  ${typeIcon} <b>${m.symbol}</b> (buyback) — $${spent.toFixed(0)}/$${budget.toFixed(0)} spent`;
          }
          const slInfo = m.stopLossPrice > 0
            ? `SL: $${m.stopLossPrice}`
            : "no SL";
          return `  ${typeIcon} <b>${m.symbol}</b> (${monitorType}) — ${slInfo}`;
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
    const monitorType = m.type ?? "standard";
    const typeLabel = monitorType === "standard" ? "📋" : monitorType === "simple" ? "🔍" : "🔄";
    const status = m.active ? "🟢" : "❌";
    const held = timeSince(m.addedAt);

    msg += `${typeLabel} <b>${m.symbol}</b> ${status} <i>(${monitorType})</i>\n`;
    msg += `   📍 <code>${m.address}</code>\n`;
    msg += `   💵 Entry: $${m.entryPrice.toPrecision(6)}\n`;

    if (m.stopLossPrice > 0) {
      const slPercent = m.entryPrice > 0
        ? ((m.entryPrice - m.stopLossPrice) / m.entryPrice * 100).toFixed(1)
        : "?";
      msg += `   🛑 SL: $${m.stopLossPrice} (${slPercent}% below)\n`;
    }

    const notifyPct = m.notifyPercent ?? 25;
    msg += `   📊 Notify: every +${notifyPct}% | Last: +${m.lastNotifiedMilestone}%\n`;

    if (monitorType === "buyback") {
      const spent = m.usdcSpent ?? 0;
      const budget = m.totalUsdcBudget ?? 0;
      const remaining = Math.max(0, budget - spent);
      msg += `   📉 Buyback: $${m.usdcPerBuyback} every -${m.buybackPercent}%\n`;
      msg += `   💰 Budget: $${spent.toFixed(2)} / $${budget.toFixed(2)} ($${remaining.toFixed(2)} left)\n`;
    }

    msg += `   ⏱️ Monitoring for: ${held}\n\n`;
  }

  msg += `Use /stop &lt;address&gt; to remove a monitor, or /stop to stop all.`;
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
    // No address provided — stop ALL monitors
    const monitors = getActiveMonitors();
    if (monitors.length === 0) {
      await ctx.reply("📭 No active monitors to stop.");
      return;
    }
    const count = monitors.length;
    clearAllMonitors();
    await ctx.reply(`⏹️ Stopped all <b>${count}</b> monitor(s).`, { parse_mode: "HTML" });
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

// ── /simple command handler ─────────────────────────────────────────

async function handleSimple(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);

  if (parts.length < 4) {
    await ctx.reply(
      `<b>Usage:</b>\n<code>/simple &lt;contract-address&gt; &lt;stop-loss&gt; &lt;notify-percent&gt;</code>\n\n` +
        `<b>Example:</b>\n<code>/simple 0x1234...abcd 0.003 5</code>\n` +
        `Monitors the token, notifies every +5% gain, auto-sells at $0.003 if you hold a position.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const contractAddress = parts[1].trim();
  const stopLoss = parseFloat(parts[2]);
  const notifyPercent = parseFloat(parts[3]);

  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
    await ctx.reply("❌ Invalid contract address. Must be a 0x... address (40 hex chars).");
    return;
  }
  if (isNaN(stopLoss) || stopLoss <= 0) {
    await ctx.reply("❌ Invalid stop-loss price. Must be a positive number.");
    return;
  }
  if (isNaN(notifyPercent) || notifyPercent <= 0) {
    await ctx.reply("❌ Invalid notify percent. Must be a positive number.");
    return;
  }

  await ctx.reply("⏳ Looking up token...");
  const info = await getTokenInfo(contractAddress);
  if (!info) {
    await ctx.reply(
      `❌ Could not find token <code>${escapeHtml(contractAddress)}</code> on Base.`,
      { parse_mode: "HTML" }
    );
    return;
  }
  if (info.priceUsd <= 0) {
    await ctx.reply(`❌ Could not get current price for <b>${escapeHtml(info.symbol)}</b>.`, { parse_mode: "HTML" });
    return;
  }
  if (stopLoss >= info.priceUsd) {
    await ctx.reply(
      `⚠️ Stop-loss ($${stopLoss}) is at or above current price ($${info.priceUsd.toPrecision(6)}).\n` +
        `Please set a stop-loss below current price.`
    );
    return;
  }

  const monitor: MonitoredToken = {
    type: "simple",
    address: info.address,
    symbol: info.symbol,
    name: info.name,
    stopLossPrice: stopLoss,
    entryPrice: info.priceUsd,
    lastNotifiedMilestone: 0,
    active: true,
    dexScreenerUrl: info.dexScreenerUrl,
    addedAt: Date.now(),
    notifyPercent,
  };

  addMonitor(monitor);

  const slPercent = ((info.priceUsd - stopLoss) / info.priceUsd * 100).toFixed(1);
  const hasPosition = !!getPosition(contractAddress);

  await ctx.reply(
    `✅ <b>Simple monitor: ${escapeHtml(info.symbol)}</b>\n\n` +
      `📍 Address: <code>${info.address}</code>\n` +
      `💵 Current price: $${info.priceUsd.toPrecision(6)}\n` +
      `🛑 Stop-loss: $${stopLoss} (${slPercent}% below)\n` +
      `📊 Notify: every +${notifyPercent}% gain\n` +
      `⏱️ Checking every ${config.monitorIntervalSec}s\n` +
      `${hasPosition ? "🔴 Will auto-sell on stop-loss (position found)" : "📢 Notify-only on stop-loss (no position held)"}\n\n` +
      `${config.dryRun ? "🔧 <b>DRY RUN MODE</b>" : "🔴 <b>LIVE MODE</b>"}`,
    { parse_mode: "HTML" }
  );
}

// ── /buyback command handler ────────────────────────────────────────

async function handleBuyback(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);

  if (parts.length < 5) {
    await ctx.reply(
      `<b>Usage:</b>\n<code>/buyback &lt;contract-address&gt; &lt;notify-percent&gt; &lt;usdc-amount&gt; &lt;buyback-percent&gt;</code>\n\n` +
        `<b>Example:</b>\n<code>/buyback 0x1234...abcd 5 100 10</code>\n` +
        `Notifies every +5% gain. Buys $100 USDC worth for every 10% dip from entry.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const contractAddress = parts[1].trim();
  const notifyPercent = parseFloat(parts[2]);
  const usdcAmount = parseFloat(parts[3]);
  const buybackPercent = parseFloat(parts[4]);

  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
    await ctx.reply("❌ Invalid contract address. Must be a 0x... address (40 hex chars).");
    return;
  }
  if (isNaN(notifyPercent) || notifyPercent <= 0) {
    await ctx.reply("❌ Invalid notify percent. Must be a positive number.");
    return;
  }
  if (isNaN(usdcAmount) || usdcAmount <= 0) {
    await ctx.reply("❌ Invalid USDC amount. Must be a positive number.");
    return;
  }
  if (isNaN(buybackPercent) || buybackPercent <= 0) {
    await ctx.reply("❌ Invalid buyback percent. Must be a positive number.");
    return;
  }

  await ctx.reply("⏳ Looking up token...");
  const info = await getTokenInfo(contractAddress);
  if (!info) {
    await ctx.reply(
      `❌ Could not find token <code>${escapeHtml(contractAddress)}</code> on Base.`,
      { parse_mode: "HTML" }
    );
    return;
  }
  if (info.priceUsd <= 0) {
    await ctx.reply(`❌ Could not get current price for <b>${escapeHtml(info.symbol)}</b>.`, { parse_mode: "HTML" });
    return;
  }

  // Check USDC balance
  const usdcBal = await getUsdcBalanceFormatted();
  const usdcBalNum = parseFloat(usdcBal);
  let balanceWarning = "";
  if (usdcBalNum < usdcAmount) {
    balanceWarning = `\n⚠️ <b>Warning:</b> USDC balance ($${usdcBalNum.toFixed(2)}) is less than budget ($${usdcAmount})`;
  }

  const monitor: MonitoredToken = {
    type: "buyback",
    address: info.address,
    symbol: info.symbol,
    name: info.name,
    stopLossPrice: 0,  // No stop-loss for buyback strategy
    entryPrice: info.priceUsd,
    lastNotifiedMilestone: 0,
    active: true,
    dexScreenerUrl: info.dexScreenerUrl,
    addedAt: Date.now(),
    notifyPercent,
    usdcPerBuyback: usdcAmount,
    buybackPercent,
    totalUsdcBudget: usdcBalNum, // Use available USDC balance as budget cap
    usdcSpent: 0,
    lastBuybackLevel: 0,
  };

  addMonitor(monitor);

  const buybackSlots = Math.floor(usdcBalNum / usdcAmount);

  await ctx.reply(
    `✅ <b>Buyback monitor: ${escapeHtml(info.symbol)}</b>\n\n` +
      `📍 Address: <code>${info.address}</code>\n` +
      `💵 Entry price: $${info.priceUsd.toPrecision(6)}\n` +
      `📊 Notify: every +${notifyPercent}% gain\n` +
      `📉 Buyback: $${usdcAmount} USDC every -${buybackPercent}% drop\n` +
      `💰 Budget: $${usdcBalNum.toFixed(2)} USDC (~${buybackSlots} buyback${buybackSlots !== 1 ? "s" : ""})\n` +
      `⏱️ Checking every ${config.monitorIntervalSec}s` +
      balanceWarning +
      `\n\n${config.dryRun ? "🔧 <b>DRY RUN MODE</b>" : "🔴 <b>LIVE MODE</b>"}`,
    { parse_mode: "HTML" }
  );
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
