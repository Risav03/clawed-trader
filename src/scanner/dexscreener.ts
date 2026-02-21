import type { Address } from "viem";
import { USDC_ADDRESS } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
}

export interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

export interface TokenCandidate {
  address: Address;
  symbol: string;
  name: string;
  priceUsd: number;
  volume24h: number;
  liquidity: number;
  priceChange1h: number;
  priceChange24h: number;
  buysSells1h: { buys: number; sells: number };
  pairAddress: string;
  pairCreatedAt: number;
  score: number;
  dexScreenerUrl: string;
}

// ── Constants ──────────────────────────────────────────────────────

const DEXSCREENER_API = "https://api.dexscreener.com";

// Conservative filter thresholds
const MIN_VOLUME_24H = 25_000;    // $25k — higher floor to weed out low-activity tokens
const MIN_LIQUIDITY = 50_000;     // $50k — ensures we can exit positions
const MIN_PAIR_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours — avoid rug-pulls in the first hours
const MAX_PAIR_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — focus on newly launched tokens
const MIN_HIKE_FOR_OLD_TOKENS = 20; // % — tokens older than 30 days must show >20% 24h gain
const MIN_BUY_SELL_RATIO = 0.6;   // Require clear buy pressure
const MAX_1H_PRICE_CHANGE = 500;  // % — skip vertical pumps likely to dump

// Tokens to always skip (stablecoins, wrapped tokens, etc.)
const SKIP_TOKENS = new Set([
  USDC_ADDRESS.toLowerCase(),
  "0x4200000000000000000000000000000000000006", // WETH
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI on Base
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", // cbETH
]);

// ── API helpers ────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "openclaw-trader/1.0" },
  });
  if (!res.ok) {
    throw new Error(`DexScreener API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Search DexScreener for trending Base chain pairs.
 * Returns newly created, high-momentum tokens that pass aggressive filters.
 */
export async function scanForCandidates(
  heldTokens: Set<string>,
  blacklist: Set<string>
): Promise<TokenCandidate[]> {
  logger.info("Scanning DexScreener for Base chain opportunities...");

  const allPairs: DexScreenerPair[] = [];

  // Also fetch trending / boosted tokens on Base
  try {
    const trendingRes = await fetchJson<Array<{ chainId: string; tokenAddress: string }>>(
      `${DEXSCREENER_API}/token-boosts/latest/v1`
    );
    // token-boosts returns an array of {chainId, tokenAddress}, we need to fetch full pair data
    const baseTokens = trendingRes.filter(t => t.chainId === "base").slice(0, 30);
    if (baseTokens.length > 0) {
      const addresses = baseTokens.map(t => t.tokenAddress).join(",");
      // /tokens/v1/ returns a raw array of pairs (not wrapped in { pairs })
      const pairs = await fetchJson<DexScreenerPair[]>(
        `${DEXSCREENER_API}/tokens/v1/base/${addresses}`
      );
      if (pairs && pairs.length > 0) {
        allPairs.push(...pairs);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch trending tokens");
  }

  // Primary: search for Base chain tokens
  try {
    const searchRes = await fetchJson<DexScreenerResponse>(
      `${DEXSCREENER_API}/latest/dex/search?q=base`
    );
    if (searchRes.pairs) {
      allPairs.push(...searchRes.pairs);
    }
  } catch (err) {
    logger.warn({ err }, "Failed DexScreener search");
  }

  // Also try searching for trending meme tokens on Base
  try {
    const memeRes = await fetchJson<DexScreenerResponse>(
      `${DEXSCREENER_API}/latest/dex/search?q=base%20meme`
    );
    if (memeRes.pairs) {
      allPairs.push(...memeRes.pairs);
    }
  } catch (err) {
    logger.warn({ err }, "Failed DexScreener meme search");
  }

  // Deduplicate by base token address
  const seen = new Set<string>();
  const uniquePairs: DexScreenerPair[] = [];
  for (const pair of allPairs) {
    const addr = pair.baseToken.address.toLowerCase();
    if (!seen.has(addr)) {
      seen.add(addr);
      uniquePairs.push(pair);
    }
  }

  logger.info({ totalPairs: uniquePairs.length }, "Fetched pairs from DexScreener");

  // Filter
  const now = Date.now();
  const candidates: TokenCandidate[] = [];

  for (const pair of uniquePairs) {
    const addr = pair.baseToken.address.toLowerCase();

    // Chain filter - only Base
    if (pair.chainId !== "base") continue;

    // Skip known stablecoins/wrapped tokens
    if (SKIP_TOKENS.has(addr)) continue;

    // Skip already-held tokens
    if (heldTokens.has(addr)) continue;

    // Skip blacklisted tokens
    if (blacklist.has(addr)) continue;

    // Volume filter
    if ((pair.volume?.h24 ?? 0) < MIN_VOLUME_24H) continue;

    // Liquidity filter
    if ((pair.liquidity?.usd ?? 0) < MIN_LIQUIDITY) continue;

    // Age filter — pair must be at least 6 hours old
    if (pair.pairCreatedAt) {
      const ageMs = now - pair.pairCreatedAt;
      if (ageMs < MIN_PAIR_AGE_MS) continue;

      // Tokens older than 30 days: only buy if 24h price change > 20%
      if (ageMs > MAX_PAIR_AGE_MS) {
        const change24h = pair.priceChange?.h24 ?? 0;
        if (change24h < MIN_HIKE_FOR_OLD_TOKENS) continue;
      }
    } else {
      // No creation date available — skip (can't assess age risk)
      continue;
    }

    // Price must exist
    const priceUsd = parseFloat(pair.priceUsd);
    if (!priceUsd || isNaN(priceUsd)) continue;

    // Buy/sell ratio check (avoid dump-only tokens)
    const h1Txns = pair.txns?.h1;
    if (h1Txns) {
      const total = h1Txns.buys + h1Txns.sells;
      if (total > 0 && h1Txns.buys / total < MIN_BUY_SELL_RATIO) continue;
    }

    // Skip extreme vertical pumps (likely to crash)
    const priceChange1h = pair.priceChange?.h1 ?? 0;
    if (priceChange1h > MAX_1H_PRICE_CHANGE) continue;

    // Score the token
    const score = computeScore(pair);

    candidates.push({
      address: pair.baseToken.address as Address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      priceUsd,
      volume24h: pair.volume?.h24 ?? 0,
      liquidity: pair.liquidity?.usd ?? 0,
      priceChange1h: pair.priceChange?.h1 ?? 0,
      priceChange24h: pair.priceChange?.h24 ?? 0,
      buysSells1h: pair.txns?.h1 ?? { buys: 0, sells: 0 },
      pairAddress: pair.pairAddress,
      pairCreatedAt: pair.pairCreatedAt ?? 0,
      score,
      dexScreenerUrl: pair.url,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  logger.info(
    { candidates: candidates.length, top3: candidates.slice(0, 3).map((c) => c.symbol) },
    "Filtered candidates"
  );

  return candidates;
}

/**
 * Get current price of a token from DexScreener.
 * Returns price in USD or null if unavailable.
 */
export async function getTokenPrice(tokenAddress: Address): Promise<number | null> {
  try {
    // /tokens/v1/ returns a raw array of pairs (not wrapped in { pairs })
    const pairs = await fetchJson<DexScreenerPair[]>(
      `${DEXSCREENER_API}/tokens/v1/base/${tokenAddress}`
    );

    if (!pairs || pairs.length === 0) return null;

    // Find the Base chain pair with highest liquidity
    const basePairs = pairs.filter((p) => p.chainId === "base");
    if (basePairs.length === 0) return null;

    basePairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(basePairs[0].priceUsd);
    return isNaN(price) ? null : price;
  } catch (err) {
    logger.warn({ err, token: tokenAddress }, "Failed to fetch token price");
    return null;
  }
}

/**
 * Get prices for multiple tokens efficiently.
 * DexScreener allows comma-separated token addresses.
 */
export async function getTokenPrices(
  tokenAddresses: Address[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (tokenAddresses.length === 0) return prices;

  // DexScreener allows up to 30 addresses per request
  const chunks: Address[][] = [];
  for (let i = 0; i < tokenAddresses.length; i += 30) {
    chunks.push(tokenAddresses.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    try {
      const joined = chunk.join(",");
      // /tokens/v1/ returns a raw array of pairs (not wrapped in { pairs })
      const pairs = await fetchJson<DexScreenerPair[]>(
        `${DEXSCREENER_API}/tokens/v1/base/${joined}`
      );

      if (!pairs || pairs.length === 0) continue;

      // Group by base token, pick highest-liquidity Base chain pair
      const byToken = new Map<string, DexScreenerPair[]>();
      for (const pair of pairs) {
        if (pair.chainId !== "base") continue;
        const addr = pair.baseToken.address.toLowerCase();
        if (!byToken.has(addr)) byToken.set(addr, []);
        byToken.get(addr)!.push(pair);
      }

      for (const [addr, pairs] of byToken) {
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const price = parseFloat(pairs[0].priceUsd);
        if (!isNaN(price)) {
          prices.set(addr, price);
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to batch-fetch token prices");
    }
  }

  return prices;
}

// ── Scoring ────────────────────────────────────────────────────────

function computeScore(pair: DexScreenerPair): number {
  let score = 0;

  // Volume score (0-30 points) — log scale
  const vol = pair.volume?.h24 ?? 0;
  if (vol > 0) {
    score += Math.min(30, Math.log10(vol) * 6);
  }

  // Liquidity score (0-25 points) — log scale
  const liq = pair.liquidity?.usd ?? 0;
  if (liq > 0) {
    score += Math.min(25, Math.log10(liq) * 5);
  }

  // 1h price momentum (0-20 points) — reward moderate momentum, penalise extremes
  const change1h = pair.priceChange?.h1 ?? 0;
  if (change1h > 0 && change1h <= 200) {
    score += Math.min(20, change1h * 0.4); // 0.4 points per % gain, capped
  } else if (change1h > 200) {
    score -= 10; // Penalise parabolic pumps
  }

  // Buy pressure (0-15 points)
  const h1Txns = pair.txns?.h1;
  if (h1Txns) {
    const total = h1Txns.buys + h1Txns.sells;
    if (total > 0) {
      const buyRatio = h1Txns.buys / total;
      score += buyRatio * 15;
    }
    // Bonus for high transaction count
    score += Math.min(5, total * 0.05);
  }

  // Volume/liquidity ratio (0-10 points) — moderate turnover is healthy
  if (liq > 0 && vol > 0) {
    const vlRatio = vol / liq;
    score += Math.min(10, vlRatio * 2);
    // Penalise extremely high turnover (potential wash trading)
    if (vlRatio > 20) score -= 5;
  }

  // Pair age bonus: tokens aged 1-7 days get a boost (survived early phase)
  if (pair.pairCreatedAt) {
    const ageHours = (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60);
    if (ageHours >= 24 && ageHours <= 168) {
      score += 10; // Sweet-spot age: survived first day, still fresh
    } else if (ageHours > 168 && ageHours <= 720) {
      score += 5; // 1-4 weeks old — still viable
    }
  }

  return Math.round(score * 100) / 100;
}
