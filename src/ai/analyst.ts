import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import type { Position } from "../positions/manager.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AIPortfolioAdvice {
  overallSentiment: "bullish" | "neutral" | "bearish";
  summary: string;
  positionAdvice: Array<{
    symbol: string;
    action: "hold" | "sell" | "tighten-stop";
    reasoning: string;
    suggestedTrailPercent?: number;
  }>;
}

/** Current bot state passed to the NL handler for context */
export interface BotState {
  focusedToken: {
    address: string;
    symbol: string;
    stopLossPercent: number;
    takeProfitPercent: number;
    active: boolean;
  } | null;
  openPositions: Array<{
    symbol: string;
    address: string;
    entryPrice: number;
    currentPrice: number;
    profitPercent: number;
    holdTimeHours: number;
  }>;
  usdcBalance: number;
  ethBalance: string;
  paused: boolean;
}

/** Structured action returned by the NL processor */
export type NLAction =
  | { type: "set_token"; address: string; stopLossPercent?: number; takeProfitPercent?: number; reply: string }
  | { type: "set_sl_tp"; stopLossPercent?: number; takeProfitPercent?: number; reply: string }
  | { type: "stop_token"; reply: string }
  | { type: "pause"; reply: string }
  | { type: "resume"; reply: string }
  | { type: "force_sell"; reply: string }
  | { type: "query"; reply: string }
  | { type: "unknown"; reply: string };

// ── Client ─────────────────────────────────────────────────────────

let client: Anthropic | null = null;

export function initAI(): void {
  if (!config.anthropicApiKey) {
    logger.warn("No ANTHROPIC_API_KEY set — AI analysis disabled, using score-only mode");
    return;
  }
  client = new Anthropic({ apiKey: config.anthropicApiKey });
  logger.info("Claude AI analyst initialized");
}

export function isAIEnabled(): boolean {
  return client !== null;
}

// ── System prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the AI trading assistant embedded in OpenClaw Trader, an autonomous Base-chain token trading bot. You help the user manage focused single-token trading through natural language.

The bot continuously monitors one token at a time, automatically buying on entry, and selling when either a stop-loss or take-profit level is hit — then immediately re-entering.

You understand the following intents (respond only in JSON, no markdown):

- set_token: User wants to start trading a specific contract address. Extract the address (must start with 0x), and optional stopLossPercent / takeProfitPercent.
- set_sl_tp: User wants to change stop-loss and/or take-profit percentages for the current focused token.
- stop_token: User wants to stop trading the current token entirely.
- pause: Pause all trading (stop opening new positions).
- resume: Resume trading.
- force_sell: Immediately sell the current open position.
- query: User is asking a question about their portfolio, P&L, status, or crypto in general. Provide a helpful conversational answer.
- unknown: Could not determine intent clearly.

Always respond with VALID JSON matching this EXACT schema:
{
  "type": "set_token" | "set_sl_tp" | "stop_token" | "pause" | "resume" | "force_sell" | "query" | "unknown",
  "address": "0x...",          // only for set_token
  "stopLossPercent": number,    // only for set_token, set_sl_tp (omit if not specified)
  "takeProfitPercent": number,  // only for set_token, set_sl_tp (omit if not specified)
  "reply": "string"             // confirmation or conversational answer
}

For address extraction: if the user says "trade 0x1234..." or "buy token 0x1234..." or "focus on 0x1234...", extract the Ethereum address.
For query/unknown, put your full conversational answer in "reply".
Be concise and helpful. No emojis unless the user uses them. No markdown in replies.`;

// ── Natural language chatbot interface ────────────────────────────

/**
 * Parse a free-text Telegram message into a structured bot action.
 * Passes the full current bot state as context so Claude can give
 * relevant portfolio-aware answers.
 */
export async function processNaturalLanguage(
  message: string,
  state: BotState
): Promise<NLAction> {
  if (!client) {
    return {
      type: "unknown",
      reply: "AI is not configured. Please set the ANTHROPIC_API_KEY environment variable.",
    };
  }

  const stateContext = JSON.stringify({
    focusedToken: state.focusedToken,
    openPositions: state.openPositions,
    usdcBalance: state.usdcBalance,
    ethBalance: state.ethBalance,
    paused: state.paused,
    defaultStopLossPercent: config.stopLossPercent,
    defaultTakeProfitPercent: config.takeProfitPercent,
  });

  const userContent = `Current bot state:\n${stateContext}\n\nUser message: ${message}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed = JSON.parse(clean) as NLAction;

    logger.info({ type: parsed.type }, "NL action parsed");
    return parsed;
  } catch (err) {
    logger.error({ err }, "NL processing failed");
    return {
      type: "unknown",
      reply: "I had trouble understanding that. Please try rephrasing, or use a slash command like /status or /portfolio.",
    };
  }
}

// ── Portfolio review ───────────────────────────────────────────────

/**
 * Ask Claude to review the current portfolio and suggest actions.
 * Called once per cycle to provide holistic advice.
 */
export async function reviewPortfolio(
  positions: Position[],
  usdcBalance: number,
  ethBalance: string
): Promise<AIPortfolioAdvice | null> {
  if (!client || positions.length === 0) return null;

  const positionData = positions.map((p) => ({
    symbol: p.tokenSymbol,
    address: p.tokenAddress,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    highestPrice: p.highestPrice,
    profitPercent: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100,
    peakProfitPercent:
      ((p.highestPrice - p.entryPrice) / p.entryPrice) * 100,
    drawdownFromPeak:
      ((p.highestPrice - p.currentPrice) / p.highestPrice) * 100,
    holdTimeHours: (Date.now() - p.entryTimestamp) / (1000 * 60 * 60),
    usdcInvested: p.usdcInvested,
  }));

  const userMessage = JSON.stringify({
    task: "portfolio_review",
    usdcBalance,
    ethBalance,
    positions: positionData,
    stopLossTiers: [
      { profitRange: "0-50%", trailPercent: 20 },
      { profitRange: "50-100%", trailPercent: 10 },
      { profitRange: ">100%", trailPercent: 5 },
    ],
    responseSchema: {
      overallSentiment: "bullish | neutral | bearish",
      summary: "string (1-2 sentences)",
      positionAdvice: [
        {
          symbol: "string",
          action: "hold | sell | tighten-stop",
          reasoning: "string (1-2 sentences)",
          suggestedTrailPercent: "number | null",
        },
      ],
    },
  });

  try {
    logger.info("Requesting Claude portfolio review");

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 768,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Strip markdown code fences if Claude wrapped the JSON
    const cleanText = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleanText) as AIPortfolioAdvice;

    logger.info(
      { sentiment: parsed.overallSentiment, advice: parsed.positionAdvice.length },
      "Claude portfolio review complete"
    );

    return parsed;
  } catch (err) {
    logger.error({ err }, "Claude portfolio review failed");
    return null;
  }
}

// ── Trade explanation ──────────────────────────────────────────────

/**
 * Generate a human-readable explanation of why a trade was made.
 * Used for Telegram notifications to give the user context.
 */
export async function explainTrade(
  action: "buy" | "sell",
  symbol: string,
  metrics: Record<string, unknown>
): Promise<string> {
  if (!client) return "";

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system:
        "You are a concise crypto trading assistant. Explain trades in 1-2 sentences for a Telegram notification. Be direct and factual. No emojis. No markdown.",
      messages: [
        {
          role: "user",
          content: `Explain this ${action}: ${symbol}. Metrics: ${JSON.stringify(metrics)}`,
        },
      ],
    });

    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "";
  } catch {
    return "";
  }
}
