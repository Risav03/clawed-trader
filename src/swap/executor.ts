import { type Address, parseUnits, type Hex } from "viem";
import {
  config,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from "../config/index.js";
import {
  getWalletClient,
  getPublicClient,
  getWalletAddress,
  ensureAllowance,
} from "../chain/wallet.js";
import { logger } from "../utils/logger.js";

// ── Types (0x v2 Allowance Holder API) ─────────────────────────────

interface ZeroXTransaction {
  to: string;
  data: string;
  gas: string | null;
  gasPrice: string;
  value: string;
}

interface ZeroXIssues {
  allowance: { actual: string; spender: string } | null;
  balance: { token: string; actual: string; expected: string } | null;
  simulationIncomplete: boolean;
  invalidSourcesPassed: string[];
}

interface ZeroXQuoteResponse {
  liquidityAvailable: boolean;
  buyAmount: string;
  buyToken: string;
  sellAmount: string;
  sellToken: string;
  allowanceTarget: string | null;
  transaction: ZeroXTransaction;
  issues: ZeroXIssues;
  minBuyAmount: string;
  route: {
    fills: Array<{ from: string; to: string; source: string; proportionBps: string }>;
    tokens: Array<{ address: string; symbol: string }>;
  };
  zid: string;
}

interface ZeroXPriceResponse {
  liquidityAvailable: boolean;
  buyAmount: string;
  buyToken: string;
  sellAmount: string;
  sellToken: string;
  allowanceTarget: string | null;
  issues: ZeroXIssues;
  minBuyAmount: string;
  route: {
    fills: Array<{ from: string; to: string; source: string; proportionBps: string }>;
    tokens: Array<{ address: string; symbol: string }>;
  };
  zid: string;
}

export interface SwapResult {
  success: boolean;
  txHash?: `0x${string}`;
  buyAmount?: string;
  sellAmount?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const ZEROX_BASE_URL = "https://api.0x.org";
const BASE_CHAIN_ID = "8453";

// ── Helpers ────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    "0x-api-key": config.zeroXApiKey,
    "0x-version": "v2",
    "Content-Type": "application/json",
  };
}

function buildParams(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  taker: string
): URLSearchParams {
  return new URLSearchParams({
    chainId: BASE_CHAIN_ID,
    sellToken,
    buyToken,
    sellAmount,
    taker,
    slippageBps: config.slippageBps.toString(),
  });
}

async function fetchQuote(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  taker: string
): Promise<ZeroXQuoteResponse> {
  const params = buildParams(sellToken, buyToken, sellAmount, taker);
  const url = `${ZEROX_BASE_URL}/swap/allowance-holder/quote?${params.toString()}`;
  logger.debug({ url: url.replace(config.zeroXApiKey, "***") }, "Fetching 0x quote");

  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`0x quote API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as ZeroXQuoteResponse;
  if (!data.liquidityAvailable) {
    throw new Error("No liquidity available for this swap");
  }
  return data;
}

async function fetchPrice(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  taker: string
): Promise<ZeroXPriceResponse> {
  const params = buildParams(sellToken, buyToken, sellAmount, taker);
  const url = `${ZEROX_BASE_URL}/swap/allowance-holder/price?${params.toString()}`;

  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`0x price API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as ZeroXPriceResponse;
  if (!data.liquidityAvailable) {
    throw new Error("No liquidity available for this swap");
  }
  return data;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get a price estimate for a swap (no execution).
 */
export async function getSwapPrice(
  sellToken: Address,
  buyToken: Address,
  sellAmountRaw: bigint
): Promise<ZeroXPriceResponse> {
  return fetchPrice(sellToken, buyToken, sellAmountRaw.toString(), getWalletAddress());
}

/**
 * Buy a token with USDC.
 *
 * @param tokenAddress - The token to buy
 * @param usdcAmount - Amount of USDC to spend (human-readable, e.g. "50" for $50)
 * @returns SwapResult with tx hash and amounts
 */
export async function buyToken(
  tokenAddress: Address,
  usdcAmount: string
): Promise<SwapResult> {
  const sellAmountRaw = parseUnits(usdcAmount, USDC_DECIMALS);
  const taker = getWalletAddress();

  logger.info(
    { token: tokenAddress, usdcAmount, sellAmountRaw: sellAmountRaw.toString() },
    "Executing BUY swap"
  );

  if (config.dryRun) {
    logger.info("DRY RUN — skipping actual swap execution");
    try {
      const priceRes = await fetchPrice(USDC_ADDRESS, tokenAddress, sellAmountRaw.toString(), taker);
      return {
        success: true,
        buyAmount: priceRes.buyAmount,
        sellAmount: priceRes.sellAmount,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  try {
    // 1. Get quote
    const quote = await fetchQuote(USDC_ADDRESS, tokenAddress, sellAmountRaw.toString(), taker);

    // 2. Ensure USDC allowance — use issues.allowance.spender or allowanceTarget
    const spender = (quote.issues.allowance?.spender ?? quote.allowanceTarget) as Address | null;
    if (spender) {
      await ensureAllowance(USDC_ADDRESS, sellAmountRaw, spender);
    }

    // 3. Execute the swap
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();

    const tx = quote.transaction;
    const txHash = await walletClient.sendTransaction({
      to: tx.to as Address,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      ...(tx.gas ? { gas: BigInt(Math.ceil(Number(tx.gas) * 1.3)) } : {}),
      gasPrice: BigInt(tx.gasPrice),
    });

    logger.info({ txHash }, "Swap transaction sent, waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    if (receipt.status === "success") {
      logger.info(
        { txHash, buyAmount: quote.buyAmount, sellAmount: quote.sellAmount },
        "BUY swap successful"
      );
      return {
        success: true,
        txHash,
        buyAmount: quote.buyAmount,
        sellAmount: quote.sellAmount,
      };
    } else {
      logger.error({ txHash, receipt }, "BUY swap transaction reverted");
      return { success: false, txHash, error: "Transaction reverted" };
    }
  } catch (err) {
    logger.error({ err, token: tokenAddress }, "BUY swap failed");
    return { success: false, error: String(err) };
  }
}

/**
 * Sell a token back to USDC.
 *
 * @param tokenAddress - The token to sell
 * @param amount - Amount of token to sell (raw, in token's smallest unit)
 * @returns SwapResult with tx hash and amounts
 */
export async function sellToken(
  tokenAddress: Address,
  amount: bigint
): Promise<SwapResult> {
  const taker = getWalletAddress();

  logger.info(
    { token: tokenAddress, amount: amount.toString() },
    "Executing SELL swap"
  );

  if (config.dryRun) {
    logger.info("DRY RUN — skipping actual sell execution");
    try {
      const priceRes = await fetchPrice(tokenAddress, USDC_ADDRESS, amount.toString(), taker);
      return {
        success: true,
        buyAmount: priceRes.buyAmount,
        sellAmount: priceRes.sellAmount,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  try {
    // 1. Get quote
    const quote = await fetchQuote(tokenAddress, USDC_ADDRESS, amount.toString(), taker);

    // 2. Ensure token allowance
    const spender = (quote.issues.allowance?.spender ?? quote.allowanceTarget) as Address | null;
    if (spender) {
      await ensureAllowance(tokenAddress, amount, spender);
    }

    // 3. Execute the swap
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();

    const tx = quote.transaction;
    const txHash = await walletClient.sendTransaction({
      to: tx.to as Address,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      ...(tx.gas ? { gas: BigInt(Math.ceil(Number(tx.gas) * 1.3)) } : {}),
      gasPrice: BigInt(tx.gasPrice),
    });

    logger.info({ txHash }, "Sell transaction sent, waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    if (receipt.status === "success") {
      logger.info(
        { txHash, buyAmount: quote.buyAmount, sellAmount: quote.sellAmount },
        "SELL swap successful"
      );
      return {
        success: true,
        txHash,
        buyAmount: quote.buyAmount,
        sellAmount: quote.sellAmount,
      };
    } else {
      logger.error({ txHash, receipt }, "SELL swap transaction reverted");
      return { success: false, txHash, error: "Transaction reverted" };
    }
  } catch (err) {
    logger.error({ err, token: tokenAddress }, "SELL swap failed");
    return { success: false, error: String(err) };
  }
}

/**
 * Sell all holdings of a token back to USDC.
 */
export async function sellAllToken(tokenAddress: Address): Promise<SwapResult> {
  const { getTokenBalance } = await import("../chain/wallet.js");
  const balance = await getTokenBalance(tokenAddress);

  if (balance === 0n) {
    return { success: false, error: "Zero token balance" };
  }

  return sellToken(tokenAddress, balance);
}
