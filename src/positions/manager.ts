import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, type Address } from "viem";
import { config, USDC_DECIMALS } from "../config/index.js";
import { getTokenPrice } from "../scanner/dexscreener.js";
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

export interface MonitoredToken {
  /** Contract address of the token being monitored */
  address: string;
  /** Token symbol (e.g. "DOGE") */
  symbol: string;
  /** Full token name */
  name: string;
  /** Absolute stop-loss price — sell when price drops to or below this */
  stopLossPrice: number;
  /** Price when monitoring was started (for 25% milestone notifications) */
  entryPrice: number;
  /** Last notified 25% milestone (e.g. 0, 25, 50, 75, 100...) */
  lastNotifiedMilestone: number;
  /** Whether this monitor is currently active */
  active: boolean;
  /** DexScreener pair URL */
  dexScreenerUrl?: string;
  /** Timestamp when monitoring started */
  addedAt: number;
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
const MONITORS_FILE = join(DATA_DIR, "monitors.json");

// ── State ──────────────────────────────────────────────────────────

let positions: Position[] = [];
let blacklist: Set<string> = new Set();
let history: TradeHistoryEntry[] = [];
let tradingPaused = false;
let monitors: MonitoredToken[] = [];

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
  monitors = loadJson<MonitoredToken[]>(MONITORS_FILE, []);

  logger.info(
    { positions: positions.length, blacklist: blacklist.size, history: history.length, monitors: monitors.length },
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

// ── Monitor management ─────────────────────────────────────────────

export function getMonitors(): MonitoredToken[] {
  return [...monitors];
}

export function getActiveMonitors(): MonitoredToken[] {
  return monitors.filter((m) => m.active);
}

export function getMonitor(address: string): MonitoredToken | undefined {
  return monitors.find(
    (m) => m.address.toLowerCase() === address.toLowerCase()
  );
}

export function addMonitor(monitor: MonitoredToken): void {
  // Remove existing monitor for same token if any
  monitors = monitors.filter(
    (m) => m.address.toLowerCase() !== monitor.address.toLowerCase()
  );
  monitors.push(monitor);
  saveJson(MONITORS_FILE, monitors);
  logger.info(
    { symbol: monitor.symbol, address: monitor.address, stopLoss: monitor.stopLossPrice },
    "Monitor added"
  );
}

export function removeMonitor(address: string): MonitoredToken | undefined {
  const idx = monitors.findIndex(
    (m) => m.address.toLowerCase() === address.toLowerCase()
  );
  if (idx === -1) return undefined;
  const [removed] = monitors.splice(idx, 1);
  saveJson(MONITORS_FILE, monitors);
  logger.info({ symbol: removed.symbol }, "Monitor removed");
  return removed;
}

export function updateMonitor(address: string, updates: Partial<MonitoredToken>): void {
  const monitor = monitors.find(
    (m) => m.address.toLowerCase() === address.toLowerCase()
  );
  if (monitor) {
    Object.assign(monitor, updates);
    saveJson(MONITORS_FILE, monitors);
  }
}

export function clearAllMonitors(): void {
  monitors = [];
  saveJson(MONITORS_FILE, monitors);
  logger.info("All monitors cleared");
}

// ── Position management ────────────────────────────────────────────

/**
 * Record a new position after a successful buy.
 */
export function addPosition(pos: Position): void {
  positions.push(pos);
  saveJson(POSITIONS_FILE, positions);

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

export function addHistoryEntry(entry: TradeHistoryEntry): void {
  history.push(entry);
  if (history.length > 100) {
    history = history.slice(-100);
  }
  saveJson(HISTORY_FILE, history);
}

/**
 * Force-sell a specific position.
 * @param reason - recorded in trade history (default: "manual")
 */
export async function forceSell(
  tokenAddress: string,
  reason: string = "manual"
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

    const usdcReceived = result.buyAmount
      ? formatUnits(BigInt(result.buyAmount), USDC_DECIMALS)
      : "0";

    addHistoryEntry({
      type: "sell",
      tokenAddress: pos.tokenAddress,
      tokenSymbol: pos.tokenSymbol,
      price: price ?? 0,
      amount: pos.quantity,
      usdcAmount: usdcReceived,
      txHash: result.txHash ?? "",
      timestamp: Date.now(),
      reason,
      profitPercent: sellProfitPercent,
    });

    removePosition(tokenAddress);
  }

  return { position: pos, result };
}

/**
 * Force-sell a token by address (for monitored tokens without Position entry).
 * Uses sellAllToken directly.
 */
export async function forceSellByAddress(
  tokenAddress: string,
  symbol: string,
  reason: string = "stop-loss"
): Promise<SwapResult> {
  if (config.dryRun) {
    logger.info({ symbol }, "DRY RUN — would sell all " + symbol);
    return { success: true };
  }

  const result = await sellAllToken(tokenAddress as Address);
  const price = await getTokenPrice(tokenAddress as Address);

  if (result.success) {
    const usdcReceived = result.buyAmount
      ? formatUnits(BigInt(result.buyAmount), USDC_DECIMALS)
      : "0";

    addHistoryEntry({
      type: "sell",
      tokenAddress,
      tokenSymbol: symbol,
      price: price ?? 0,
      amount: "all",
      usdcAmount: usdcReceived,
      txHash: result.txHash ?? "",
      timestamp: Date.now(),
      reason,
    });
  }

  return result;
}

/**
 * Save current state to disk (call on shutdown).
 */
export function saveAllState(): void {
  saveJson(POSITIONS_FILE, positions);
  saveJson(BLACKLIST_FILE, [...blacklist]);
  saveJson(HISTORY_FILE, history);
  saveJson(MONITORS_FILE, monitors);
  logger.info("All state persisted to disk");
}
