import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { STOP_LOSS_TIERS, config } from "../config/index.js";
import { getTokenPrices, getTokenPrice } from "../scanner/dexscreener.js";
import { sellAllToken, type SwapResult } from "../swap/executor.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface Position {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  entryPrice: number;       // USD price at entry
  currentPrice: number;     // Latest known price
  highestPrice: number;     // Highest price since entry
  quantity: string;          // Raw token amount (as string to preserve bigint)
  usdcInvested: string;     // USDC amount spent
  entryTimestamp: number;    // Unix ms
  buyTxHash: string;
  dexScreenerUrl: string;
}

export interface TradeHistoryEntry {
  type: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  price: number;
  amount: string;
  usdcAmount: string;
  txHash: string;
  timestamp: number;
  reason?: string;           // For sells: "stop-loss", "manual", etc.
  profitPercent?: number;
}

// ── File paths ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const POSITIONS_FILE = join(DATA_DIR, "positions.json");
const BLACKLIST_FILE = join(DATA_DIR, "blacklist.json");
const HISTORY_FILE = join(DATA_DIR, "history.json");

// ── State ──────────────────────────────────────────────────────────

let positions: Position[] = [];
let blacklist: Set<string> = new Set();
let history: TradeHistoryEntry[] = [];
let tradingPaused = false;

// ── Persistence ────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    logger.warn({ err, filePath }, "Failed to load JSON file, using fallback");
  }
  return fallback;
}

function saveJson(filePath: string, data: unknown): void {
  ensureDataDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Initialization ─────────────────────────────────────────────────

export function initPositionManager(): void {
  ensureDataDir();
  positions = loadJson<Position[]>(POSITIONS_FILE, []);
  const blacklistArr = loadJson<string[]>(BLACKLIST_FILE, []);
  blacklist = new Set(blacklistArr.map((a) => a.toLowerCase()));
  history = loadJson<TradeHistoryEntry[]>(HISTORY_FILE, []);

  logger.info(
    { positions: positions.length, blacklist: blacklist.size, history: history.length },
    "Position manager initialized"
  );
}

// ── Getters ────────────────────────────────────────────────────────

export function getPositions(): Position[] {
  return [...positions];
}

export function getOpenPositionCount(): number {
  return positions.length;
}

export function getHeldTokenAddresses(): Set<string> {
  return new Set(positions.map((p) => p.tokenAddress.toLowerCase()));
}

export function getBlacklist(): Set<string> {
  return new Set(blacklist);
}

export function getHistory(limit = 10): TradeHistoryEntry[] {
  return history.slice(-limit);
}

export function getFullHistory(): TradeHistoryEntry[] {
  return [...history];
}

export function isTradingPaused(): boolean {
  return tradingPaused;
}

export function setPaused(paused: boolean): void {
  tradingPaused = paused;
  logger.info({ paused }, "Trading paused state changed");
}

// ── Position management ────────────────────────────────────────────

/**
 * Record a new position after a successful buy.
 */
export function addPosition(pos: Position): void {
  positions.push(pos);
  saveJson(POSITIONS_FILE, positions);

  // Record in history
  addHistoryEntry({
    type: "buy",
    tokenAddress: pos.tokenAddress,
    tokenSymbol: pos.tokenSymbol,
    price: pos.entryPrice,
    amount: pos.quantity,
    usdcAmount: pos.usdcInvested,
    txHash: pos.buyTxHash,
    timestamp: pos.entryTimestamp,
  });

  logger.info(
    { symbol: pos.tokenSymbol, price: pos.entryPrice, invested: pos.usdcInvested },
    "Position added"
  );
}

/**
 * Remove a position (after selling).
 */
export function removePosition(tokenAddress: string): Position | undefined {
  const idx = positions.findIndex(
    (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (idx === -1) return undefined;

  const [removed] = positions.splice(idx, 1);
  saveJson(POSITIONS_FILE, positions);

  logger.info({ symbol: removed.tokenSymbol }, "Position removed");
  return removed;
}

/**
 * Get a position by token address.
 */
export function getPosition(tokenAddress: string): Position | undefined {
  return positions.find(
    (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );
}

// ── Blacklist ──────────────────────────────────────────────────────

export function addToBlacklist(tokenAddress: string): void {
  blacklist.add(tokenAddress.toLowerCase());
  saveJson(BLACKLIST_FILE, [...blacklist]);
  logger.info({ token: tokenAddress }, "Token added to blacklist");
}

export function removeFromBlacklist(tokenAddress: string): void {
  blacklist.delete(tokenAddress.toLowerCase());
  saveJson(BLACKLIST_FILE, [...blacklist]);
}

// ── History ────────────────────────────────────────────────────────

function addHistoryEntry(entry: TradeHistoryEntry): void {
  history.push(entry);
  // Keep last 100 entries
  if (history.length > 100) {
    history = history.slice(-100);
  }
  saveJson(HISTORY_FILE, history);
}

// ── Stop-loss engine ───────────────────────────────────────────────

/**
 * Compute the trailing stop-loss price for a position.
 * Uses tiered trailing: tighter trail at higher profits.
 */
export function computeStopPrice(position: Position): {
  stopPrice: number;
  trailPercent: number;
  profitPercent: number;
} {
  const profitPercent =
    ((position.highestPrice - position.entryPrice) / position.entryPrice) * 100;

  // Find the applicable tier
  let trailPercent = 20; // default
  for (const tier of STOP_LOSS_TIERS) {
    if (profitPercent >= tier.minProfitPercent) {
      trailPercent = tier.trailPercent;
      break; // Tiers are sorted descending by minProfitPercent
    }
  }

  const stopPrice = position.highestPrice * (1 - trailPercent / 100);

  return { stopPrice, trailPercent, profitPercent };
}

/**
 * Check all positions against current prices and trigger stop-loss sells.
 * Returns array of positions that were sold.
 */
export async function evaluateStopLosses(): Promise<
  Array<{ position: Position; result: SwapResult; reason: string }>
> {
  if (positions.length === 0) return [];

  const tokenAddresses = positions.map((p) => p.tokenAddress as Address);
  const prices = await getTokenPrices(tokenAddresses);

  const sold: Array<{ position: Position; result: SwapResult; reason: string }> = [];

  // Iterate over a copy since we may modify positions
  for (const pos of [...positions]) {
    const addr = pos.tokenAddress.toLowerCase();
    const currentPrice = prices.get(addr);

    if (currentPrice == null) {
      logger.warn({ symbol: pos.tokenSymbol }, "Could not fetch price, skipping");
      continue;
    }

    // Update current price
    pos.currentPrice = currentPrice;

    // Update highest price
    if (currentPrice > pos.highestPrice) {
      pos.highestPrice = currentPrice;
    }

    // Compute stop price
    const { stopPrice, trailPercent, profitPercent } = computeStopPrice(pos);

    logger.debug(
      {
        symbol: pos.tokenSymbol,
        currentPrice,
        highestPrice: pos.highestPrice,
        stopPrice,
        trailPercent,
        profitPercent: profitPercent.toFixed(2),
      },
      "Stop-loss check"
    );

    // Check if price has fallen below stop
    if (currentPrice <= stopPrice) {
      const reason = `Tiered trailing stop-loss triggered (${trailPercent}% trail, profit was ${profitPercent.toFixed(1)}%)`;
      logger.info(
        { symbol: pos.tokenSymbol, currentPrice, stopPrice, trailPercent },
        "STOP-LOSS TRIGGERED — selling position"
      );

      if (config.dryRun) {
        logger.info({ symbol: pos.tokenSymbol }, "DRY RUN — would sell here");
        sold.push({
          position: pos,
          result: { success: true },
          reason,
        });
        continue;
      }

      // Execute sell
      const result = await sellAllToken(pos.tokenAddress as Address);

      if (result.success) {
        const sellProfitPercent =
          ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        addHistoryEntry({
          type: "sell",
          tokenAddress: pos.tokenAddress,
          tokenSymbol: pos.tokenSymbol,
          price: currentPrice,
          amount: pos.quantity,
          usdcAmount: result.buyAmount ?? "0", // USDC received
          txHash: result.txHash ?? "",
          timestamp: Date.now(),
          reason: "stop-loss",
          profitPercent: sellProfitPercent,
        });

        removePosition(pos.tokenAddress);
        sold.push({ position: pos, result, reason });
      } else {
        logger.error(
          { symbol: pos.tokenSymbol, error: result.error },
          "Stop-loss sell FAILED — will retry next cycle"
        );
      }
    }
  }

  // Save updated prices and highest prices
  saveJson(POSITIONS_FILE, positions);

  return sold;
}

/**
 * Force-sell a specific position.
 */
export async function forceSell(
  tokenAddress: string
): Promise<{ position: Position; result: SwapResult } | null> {
  const pos = getPosition(tokenAddress);
  if (!pos) return null;

  const price = await getTokenPrice(tokenAddress as Address);

  if (config.dryRun) {
    logger.info({ symbol: pos.tokenSymbol }, "DRY RUN — would force sell");
    removePosition(tokenAddress);
    return { position: pos, result: { success: true } };
  }

  const result = await sellAllToken(tokenAddress as Address);

  if (result.success) {
    const sellProfitPercent = price
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100
      : 0;

    addHistoryEntry({
      type: "sell",
      tokenAddress: pos.tokenAddress,
      tokenSymbol: pos.tokenSymbol,
      price: price ?? 0,
      amount: pos.quantity,
      usdcAmount: result.buyAmount ?? "0",
      txHash: result.txHash ?? "",
      timestamp: Date.now(),
      reason: "manual",
      profitPercent: sellProfitPercent,
    });

    removePosition(tokenAddress);
  }

  return { position: pos, result };
}

/**
 * Save current state to disk (call on shutdown).
 */
export function saveAllState(): void {
  saveJson(POSITIONS_FILE, positions);
  saveJson(BLACKLIST_FILE, [...blacklist]);
  saveJson(HISTORY_FILE, history);
  logger.info("All state persisted to disk");
}
