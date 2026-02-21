import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import type { TokenCandidate } from "../scanner/dexscreener.js";
import type { Position } from "../positions/manager.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AITokenVerdict {
  symbol: string;
  address: string;
  action: "buy" | "skip";
  confidence: number;       // 0-100
  reasoning: string;
  riskLevel: "low" | "medium" | "high" | "extreme";
  suggestedAllocPercent?: number; // Override default 10% if AI suggests less
}

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

const SYSTEM_PROMPT = `You are an expert crypto trading analyst embedded in an autonomous trading bot operating on the Base chain (Layer 2 on Ethereum). Your role is to analyze token data from DexScreener and provide precise, actionable trading decisions.

CONTEXT:
- The bot trades on Base chain using USDC as the base currency
- It uses the 0x aggregator for swaps
- It applies tiered trailing stop-losses: 20% trail at 0-50% profit, 10% at 50-100%, 5% at >100%
- Max 5 concurrent positions, investing 10% of USDC balance per trade
- Aggressive filter thresholds: >$10k volume/24h, >$25k liquidity, >1 hour old

YOUR ANALYSIS FRAMEWORK:
1. **Liquidity Depth**: Is there enough liquidity to enter AND exit? Look for at least 2x your position size in liquidity.
2. **Volume Authenticity**: Is volume organic or wash-traded? Look for reasonable buy/sell ratios and transaction counts.
3. **Price Action**: Momentum is good, but vertical pumps without consolidation often precede dumps.
4. **Token Age**: Very new tokens (<6 hours) are higher risk. Tokens that have survived 24h+ with growing metrics are stronger.
5. **Red Flags**: Extremely high price changes (>500% in 1h), low unique traders, concentrated liquidity.

RESPONSE FORMAT: Always respond with valid JSON matching the requested schema. No markdown, no explanations outside the JSON.`;

// ── Token analysis ─────────────────────────────────────────────────

/**
 * Analyze a batch of token candidates using Claude.
 * Returns AI verdicts with buy/skip recommendations.
 */
export async function analyzeTokenCandidates(
  candidates: TokenCandidate[],
  currentPortfolio: Position[],
  usdcBalance: number
): Promise<AITokenVerdict[]> {
  if (!client || candidates.length === 0) {
    // Fallback: approve all candidates (score-only mode)
    return candidates.map((c) => ({
      symbol: c.symbol,
      address: c.address,
      action: "buy" as const,
      confidence: c.score,
      reasoning: "AI disabled — using DexScreener score only",
      riskLevel: "medium" as const,
    }));
  }

  const portfolioSummary = currentPortfolio.map((p) => ({
    symbol: p.tokenSymbol,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    profitPercent: ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100,
    holdTimeHours: (Date.now() - p.entryTimestamp) / (1000 * 60 * 60),
  }));

  const candidateData = candidates.slice(0, 10).map((c) => ({
    symbol: c.symbol,
    name: c.name,
    address: c.address,
    priceUsd: c.priceUsd,
    volume24h: c.volume24h,
    liquidity: c.liquidity,
    priceChange1h: c.priceChange1h,
    priceChange24h: c.priceChange24h,
    buysSells1h: c.buysSells1h,
    pairAgeHours: c.pairCreatedAt
      ? (Date.now() - c.pairCreatedAt) / (1000 * 60 * 60)
      : null,
    dexScreenerScore: c.score,
  }));

  const userMessage = JSON.stringify({
    task: "analyze_candidates",
    usdcBalance,
    currentPositionCount: currentPortfolio.length,
    maxPositions: config.maxPositions,
    investPercentPerTrade: config.tradePercent,
    currentPortfolio: portfolioSummary,
    candidates: candidateData,
    responseSchema: {
      verdicts: [
        {
          symbol: "string",
          address: "string",
          action: "buy | skip",
          confidence: "number 0-100",
          reasoning: "string (2-3 sentences max)",
          riskLevel: "low | medium | high | extreme",
          suggestedAllocPercent: "number | null",
        },
      ],
    },
  });

  try {
    logger.info(
      { candidateCount: candidateData.length },
      "Sending candidates to Claude for analysis"
    );

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
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

    const parsed = JSON.parse(cleanText) as { verdicts: AITokenVerdict[] };

    logger.info(
      {
        total: parsed.verdicts.length,
        buys: parsed.verdicts.filter((v) => v.action === "buy").length,
        skips: parsed.verdicts.filter((v) => v.action === "skip").length,
      },
      "Claude analysis complete"
    );

    return parsed.verdicts;
  } catch (err) {
    logger.error({ err }, "Claude analysis failed — falling back to score-only");
    return candidates.map((c) => ({
      symbol: c.symbol,
      address: c.address,
      action: "buy" as const,
      confidence: c.score,
      reasoning: "AI analysis failed — using DexScreener score fallback",
      riskLevel: "medium" as const,
    }));
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 1536,
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
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
