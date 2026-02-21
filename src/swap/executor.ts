import { type Address, parseUnits, formatUnits, type Hex } from "viem";
import {
  config,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ZEROX_EXCHANGE_PROXY,
} from "../config/index.js";
import {
  getWalletClient,
  getPublicClient,
  getWalletAddress,
  ensureAllowance,
  getTokenDecimals,
} from "../chain/wallet.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

interface ZeroXQuoteResponse {
  price: string;
  guaranteedPrice: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  estimatedGas: string;
  gasPrice: string;
  protocolFee: string;
  minimumProtocolFee: string;
  buyTokenAddress: string;
  sellTokenAddress: string;
  buyAmount: string;
  sellAmount: string;
  estimatedPriceImpact: string;
  sources: Array<{ name: string; proportion: string }>;
  allowanceTarget: string;
}

interface ZeroXPriceResponse {
  price: string;
  estimatedPriceImpact: string;
  buyAmount: string;
  sellAmount: string;
  sources: Array<{ name: string; proportion: string }>;
}

export interface SwapResult {
  success: boolean;
  txHash?: `0x${string}`;
  buyAmount?: string;
  sellAmount?: string;
  error?: string;
  priceImpact?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const ZEROX_BASE_URL = "https://base.api.0x.org";

// ── Helpers ────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    "0x-api-key": config.zeroXApiKey,
    "0x-chain-id": "8453",
    "Content-Type": "application/json",
  };
}

async function fetchQuote(params: URLSearchParams): Promise<ZeroXQuoteResponse> {
  const url = `${ZEROX_BASE_URL}/swap/v1/quote?${params.toString()}`;
  logger.debug({ url: url.replace(config.zeroXApiKey, "***") }, "Fetching 0x quote");

  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`0x API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<ZeroXQuoteResponse>;
}

async function fetchPrice(params: URLSearchParams): Promise<ZeroXPriceResponse> {
  const url = `${ZEROX_BASE_URL}/swap/v1/price?${params.toString()}`;
  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`0x price API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<ZeroXPriceResponse>;
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
  const params = new URLSearchParams({
    sellToken,
    buyToken,
    sellAmount: sellAmountRaw.toString(),
    takerAddress: getWalletAddress(),
    slippagePercentage: (config.slippageBps / 10000).toString(),
  });

  return fetchPrice(params);
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

  logger.info(
    { token: tokenAddress, usdcAmount, sellAmountRaw: sellAmountRaw.toString() },
    "Executing BUY swap"
  );

  if (config.dryRun) {
    logger.info("DRY RUN — skipping actual swap execution");
    try {
      const priceRes = await getSwapPrice(USDC_ADDRESS, tokenAddress, sellAmountRaw);
      return {
        success: true,
        buyAmount: priceRes.buyAmount,
        sellAmount: priceRes.sellAmount,
        priceImpact: priceRes.estimatedPriceImpact,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  try {
    // 1. Ensure USDC allowance for 0x
    const quote = await fetchQuote(
      new URLSearchParams({
        sellToken: USDC_ADDRESS,
        buyToken: tokenAddress,
        sellAmount: sellAmountRaw.toString(),
        takerAddress: getWalletAddress(),
        slippagePercentage: (config.slippageBps / 10000).toString(),
      })
    );

    // Use the allowance target from the quote
    const allowanceTarget = (quote.allowanceTarget || ZEROX_EXCHANGE_PROXY) as Address;
    await ensureAllowance(USDC_ADDRESS, sellAmountRaw, allowanceTarget);

    // 2. Execute the swap
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();

    const txHash = await walletClient.sendTransaction({
      to: quote.to as Address,
      data: quote.data as Hex,
      value: BigInt(quote.value || "0"),
      gas: BigInt(Math.ceil(Number(quote.estimatedGas) * 1.3)), // 30% gas buffer
    });

    logger.info({ txHash }, "Swap transaction sent, waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    if (receipt.status === "success") {
      logger.info(
        {
          txHash,
          buyAmount: quote.buyAmount,
          sellAmount: quote.sellAmount,
          priceImpact: quote.estimatedPriceImpact,
        },
        "BUY swap successful"
      );
      return {
        success: true,
        txHash,
        buyAmount: quote.buyAmount,
        sellAmount: quote.sellAmount,
        priceImpact: quote.estimatedPriceImpact,
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
  logger.info(
    { token: tokenAddress, amount: amount.toString() },
    "Executing SELL swap"
  );

  if (config.dryRun) {
    logger.info("DRY RUN — skipping actual sell execution");
    try {
      const priceRes = await getSwapPrice(tokenAddress, USDC_ADDRESS, amount);
      return {
        success: true,
        buyAmount: priceRes.buyAmount,
        sellAmount: priceRes.sellAmount,
        priceImpact: priceRes.estimatedPriceImpact,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  try {
    // 1. Get quote
    const quote = await fetchQuote(
      new URLSearchParams({
        sellToken: tokenAddress,
        buyToken: USDC_ADDRESS,
        sellAmount: amount.toString(),
        takerAddress: getWalletAddress(),
        slippagePercentage: (config.slippageBps / 10000).toString(),
      })
    );

    // 2. Ensure allowance
    const allowanceTarget = (quote.allowanceTarget || ZEROX_EXCHANGE_PROXY) as Address;
    await ensureAllowance(tokenAddress, amount, allowanceTarget);

    // 3. Execute the swap
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();

    const txHash = await walletClient.sendTransaction({
      to: quote.to as Address,
      data: quote.data as Hex,
      value: BigInt(quote.value || "0"),
      gas: BigInt(Math.ceil(Number(quote.estimatedGas) * 1.3)),
    });

    logger.info({ txHash }, "Sell transaction sent, waiting for confirmation...");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    if (receipt.status === "success") {
      logger.info(
        {
          txHash,
          buyAmount: quote.buyAmount,
          sellAmount: quote.sellAmount,
          priceImpact: quote.estimatedPriceImpact,
        },
        "SELL swap successful"
      );
      return {
        success: true,
        txHash,
        buyAmount: quote.buyAmount,
        sellAmount: quote.sellAmount,
        priceImpact: quote.estimatedPriceImpact,
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
