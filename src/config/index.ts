import "dotenv/config";
import { type Address, parseEther } from "viem";

// ── Required env vars ──────────────────────────────────────────────
function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// ── Config object ──────────────────────────────────────────────────

interface AppConfig {
  /** Wallet private key (hex, with 0x prefix) */
  privateKey: `0x${string}`;
  /** Telegram bot token from @BotFather */
  telegramBotToken: string;
  /** Your personal Telegram chat ID for notifications */
  telegramChatId: string;
  /** 0x Swap API key */
  zeroXApiKey: string;
  /** Base chain RPC URL */
  baseRpcUrl: string;
  /** ETH balance below which a warning is sent (in wei) */
  ethWarnThreshold: bigint;
  /** Maximum concurrent token positions */
  maxPositions: number;
  /** Percentage of USDC balance to invest per trade */
  tradePercent: number;
  /** Minimum USDC to keep in wallet (won't trade below this) */
  minUsdcBalance: number;
  /** Slippage tolerance in basis points (100 = 1%) */
  slippageBps: number;
  /** If true, log trades but don't execute them */
  dryRun: boolean;
  /** Anthropic API key for Claude-powered analysis */
  anthropicApiKey: string;
  /** HTTP API port for the public dashboard */
  apiPort: number;
  /** Flat stop-loss % below entry price (default 5) */
  stopLossPercent: number;
  /** Take-profit % above entry price (default 20) */
  takeProfitPercent: number;
  /** Seconds to wait before re-entering after SL/TP trigger */
  reentryCooldownSec: number;
  /** Pre-seed focused token on startup (optional) */
  focusedToken: string;
}

export const config: AppConfig = {
  privateKey: "0x" as `0x${string}`,
  telegramBotToken: "",
  telegramChatId: "",
  zeroXApiKey: "",
  baseRpcUrl: "",
  ethWarnThreshold: 0n,
  maxPositions: 5,
  tradePercent: 10,
  minUsdcBalance: 10,
  slippageBps: 100,
  dryRun: false,
  anthropicApiKey: "",
  apiPort: 3000,
  stopLossPercent: 5,
  takeProfitPercent: 20,
  reentryCooldownSec: 30,
  focusedToken: "",
};

export function loadConfig(): void {
  const pk = requiredEnv("PRIVATE_KEY");
  config.privateKey = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;

  config.telegramBotToken = requiredEnv("TELEGRAM_BOT_TOKEN");
  config.telegramChatId = requiredEnv("TELEGRAM_CHAT_ID");
  config.zeroXApiKey = requiredEnv("ZEROX_API_KEY");

  config.baseRpcUrl = optionalEnv("BASE_RPC_URL", "https://mainnet.base.org");
  config.ethWarnThreshold = parseEther(optionalEnv("ETH_WARN_THRESHOLD", "0.001"));
  config.maxPositions = parseInt(optionalEnv("MAX_POSITIONS", "5"), 10);
  config.tradePercent = parseInt(optionalEnv("TRADE_PERCENT", "10"), 10);
  config.minUsdcBalance = parseFloat(optionalEnv("MIN_USDC_BALANCE", "10"));
  config.slippageBps = parseInt(optionalEnv("SLIPPAGE_BPS", "100"), 10);
  config.dryRun = optionalEnv("DRY_RUN", "false").toLowerCase() === "true";
  config.anthropicApiKey = optionalEnv("ANTHROPIC_API_KEY", "");
  config.apiPort = parseInt(optionalEnv("PORT", "3000"), 10);
  config.stopLossPercent = parseFloat(optionalEnv("STOP_LOSS_PERCENT", "5"));
  config.takeProfitPercent = parseFloat(optionalEnv("TAKE_PROFIT_PERCENT", "20"));
  config.reentryCooldownSec = parseInt(optionalEnv("REENTRY_COOLDOWN_SEC", "30"), 10);
  config.focusedToken = optionalEnv("FOCUSED_TOKEN", "");
}

// ── Base chain constants ───────────────────────────────────────────
export const BASE_CHAIN_ID = 8453;
export const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_ADDRESS: Address = "0x4200000000000000000000000000000000000006";

/** 0x Exchange Proxy on Base */
export const ZEROX_EXCHANGE_PROXY: Address = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

/** USDC has 6 decimals on Base */
export const USDC_DECIMALS = 6;

/** Standard ERC-20 ABI fragments we need */
export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** Trailing stop-loss tier configuration */
export const STOP_LOSS_TIERS = [
  { minProfitPercent: 100, trailPercent: 5 },   // >100% profit → 5% trail
  { minProfitPercent: 50, trailPercent: 10 },    // 50-100% profit → 10% trail
  { minProfitPercent: 0, trailPercent: 20 },     // 0-50% profit → 20% trail
] as const;
