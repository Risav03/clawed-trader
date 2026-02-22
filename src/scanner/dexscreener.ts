import type { Address } from "viem";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

interface DexScreenerPair {
  chainId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  liquidity?: {
    usd: number;
  };
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  dexScreenerUrl: string;
}

// ── Constants ──────────────────────────────────────────────────────

const DEXSCREENER_API = "https://api.dexscreener.com";

// ── API helper ─────────────────────────────────────────────────────

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

      for (const [addr, tokenPairs] of byToken) {
        tokenPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const price = parseFloat(tokenPairs[0].priceUsd);
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

// ── Token info ─────────────────────────────────────────────────────

/**
 * Get full token information (symbol, name, price, DexScreener URL)
 * for a given contract address on Base.
 * Returns null if the token cannot be found.
 */
export async function getTokenInfo(tokenAddress: string): Promise<TokenInfo | null> {
  try {
    const pairs = await fetchJson<DexScreenerPair[]>(
      `${DEXSCREENER_API}/tokens/v1/base/${tokenAddress}`
    );

    if (!pairs || pairs.length === 0) return null;

    const basePairs = pairs.filter((p) => p.chainId === "base");
    if (basePairs.length === 0) return null;

    basePairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = basePairs[0];
    const price = parseFloat(best.priceUsd);

    return {
      address: tokenAddress.toLowerCase(),
      symbol: best.baseToken.symbol,
      name: best.baseToken.name,
      priceUsd: isNaN(price) ? 0 : price,
      dexScreenerUrl: best.url,
    };
  } catch (err) {
    logger.warn({ err, token: tokenAddress }, "Failed to fetch token info");
    return null;
  }
}
