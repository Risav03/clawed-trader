import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  type Address,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  type HttpTransport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  config,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ERC20_ABI,
  ZEROX_EXCHANGE_PROXY,
} from "../config/index.js";
import { logger } from "../utils/logger.js";

// ── Clients (initialized lazily) ──────────────────────────────────
let publicClient: PublicClient<HttpTransport, typeof base>;
let walletClient: WalletClient<HttpTransport, typeof base, Account>;
let walletAddress: Address;

/**
 * Initialize viem clients. Must be called after loadConfig().
 */
export function initWallet(): void {
  const account = privateKeyToAccount(config.privateKey);
  walletAddress = account.address;

  publicClient = createPublicClient({
    chain: base,
    transport: http(config.baseRpcUrl),
  });

  walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(config.baseRpcUrl),
  });

  logger.info({ address: walletAddress }, "Wallet initialized on Base chain");
}

/** Get the wallet address */
export function getWalletAddress(): Address {
  return walletAddress;
}

/** Get the public client */
export function getPublicClient(): PublicClient<HttpTransport, typeof base> {
  return publicClient;
}

/** Get the wallet client */
export function getWalletClient(): WalletClient<HttpTransport, typeof base, Account> {
  return walletClient;
}

// ── Balance helpers ────────────────────────────────────────────────

/** Get native ETH balance in wei */
export async function getEthBalance(): Promise<bigint> {
  return publicClient.getBalance({ address: walletAddress });
}

/** Get ETH balance formatted as a string */
export async function getEthBalanceFormatted(): Promise<string> {
  const bal = await getEthBalance();
  return formatEther(bal);
}

/** Get USDC balance (raw, 6-decimal) */
export async function getUsdcBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  }) as Promise<bigint>;
}

/** Get USDC balance formatted as a human-readable string */
export async function getUsdcBalanceFormatted(): Promise<string> {
  const bal = await getUsdcBalance();
  return formatUnits(bal, USDC_DECIMALS);
}

/** Get any ERC-20 token balance */
export async function getTokenBalance(tokenAddress: Address): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  }) as Promise<bigint>;
}

/** Get token symbol */
export async function getTokenSymbol(tokenAddress: Address): Promise<string> {
  try {
    return (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    })) as string;
  } catch {
    return "UNKNOWN";
  }
}

/** Get token decimals */
export async function getTokenDecimals(tokenAddress: Address): Promise<number> {
  try {
    return Number(
      await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      })
    );
  } catch {
    return 18;
  }
}

// ── Approval helpers ───────────────────────────────────────────────

/** Check current allowance of a token for 0x Exchange Proxy */
export async function getAllowance(
  tokenAddress: Address,
  spender: Address = ZEROX_EXCHANGE_PROXY
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [walletAddress, spender],
  }) as Promise<bigint>;
}

/** Approve token spending for 0x Exchange Proxy. Returns tx hash. */
export async function approveToken(
  tokenAddress: Address,
  amount: bigint,
  spender: Address = ZEROX_EXCHANGE_PROXY
): Promise<`0x${string}`> {
  logger.info(
    { token: tokenAddress, amount: amount.toString(), spender },
    "Approving token spend"
  );

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
  });

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  logger.info({ hash, status: receipt.status }, "Approval confirmed");

  return hash;
}

/**
 * Ensure a token has enough allowance for `amount`.
 * If not, approve max uint256.
 */
export async function ensureAllowance(
  tokenAddress: Address,
  amount: bigint,
  spender: Address = ZEROX_EXCHANGE_PROXY
): Promise<void> {
  const current = await getAllowance(tokenAddress, spender);
  if (current >= amount) {
    logger.debug({ token: tokenAddress }, "Allowance sufficient");
    return;
  }

  // Approve max to avoid repeated approvals
  const maxApproval = 2n ** 256n - 1n;
  await approveToken(tokenAddress, maxApproval, spender);
}
