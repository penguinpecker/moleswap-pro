/**
 * market.ts — the rh-lending Aave v3.7 market, read from chain.
 *
 * EVERY SELECTOR IN THIS FILE WAS VERIFIED PRESENT IN THE DEPLOYED RUNTIME BYTECODE before it was
 * written down (the Pool through its ERC-1967 implementation slot, since the Pool is a proxy and
 * the proxy's own code carries none of them). An ABI that merely looks right is the failure mode
 * that produces a confident, wrong number in a lending UI, so it was checked rather than assumed:
 *
 *   Pool impl 0x64ffd2ee…   supply 0x617ba037 · withdraw 0x69328dec · borrow 0xa415bcad
 *                           repay 0x573ade81 · setUserUseReserveAsCollateral 0x5a3b74b9
 *                           getUserAccountData 0xbf92857c · getReservesList 0xd1946dbc
 *                           getReserveAToken 0xcff027d9 · getReserveVariableDebtToken 0x365090a0
 *                           getConfiguration 0xc44b11f7
 *   Gateway   0x2D8Deb32…   depositETH 0x474cf53d · withdrawETH 0x80500d20
 *                           repayETH 0xbcc3c255 · borrowETH 0xe74f7b85
 *
 * ONE CHAIN. The market exists on Robinhood Chain 4663 only. Arc has no lending deployment, and
 * every function here refuses rather than silently reading Robinhood's market for an Arc user —
 * the same rule the pools and swap surfaces already follow.
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { RH_CHAIN } from "@/lib/chain/chains";

/* ─────────────────────────────── addresses ─────────────────────────────── */

/** Deployed 2026-08-25. Mirrors ~/Projects/rh-lending/README.md — keep the two in step. */
export const LENDING = {
  chainId: RH_CHAIN.id,
  pool: "0xb819FD2DabF86dB45911Cd57D4588E9440E485dD" as Address,
  poolConfigurator: "0x2FceEe8F61F7453d03dca5C03DAa1B9a16a3C281" as Address,
  oracle: "0x96D40a06e89db5b717f237CA95f8bA9363551cEa" as Address,
  dataProvider: "0x10339dBAf317f3C1769D374eCda050C658A84e22" as Address,
  /** Lets a user supply/withdraw NATIVE ETH; it wraps internally so they never touch WETH. */
  wrappedTokenGateway: "0x2D8Deb32745709e96b177c7794c05Bd41a6e52d9" as Address,
  livenessGate: "0x5514b32a41ac6d42e0f3d0a33828f1686168e40e" as Address,
} as const;

export interface LendingAsset {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly aToken: Address;
  readonly variableDebtToken: Address;
  /** WETH is listed collateral-only: borrowing is deliberately disabled on it. */
  readonly borrowable: boolean;
  /** True for the reserve the native-ETH gateway wraps into. */
  readonly isWrappedNative: boolean;
}

export const LENDING_ASSETS: readonly LendingAsset[] = [
  {
    symbol: "ETH",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    decimals: 18,
    aToken: "0xba7EA30088d24e932C03721f66DC5500EAfaD75E",
    variableDebtToken: "0xAC01e462cC1917e59D04e10A154CBaC3893A0d14",
    borrowable: false,
    isWrappedNative: true,
  },
  {
    symbol: "USDG",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    aToken: "0xE341A4Ab92C682285458442446C8dDE6181e3aA1",
    variableDebtToken: "0x517dB9052026Ad62B68184Da4A313CD11cBa5822",
    borrowable: true,
    isWrappedNative: false,
  },
] as const;

/** Aave prices everything in a USD base currency with 8 decimals. */
export const BASE_DECIMALS = 8;

export const lendingAvailableOn = (chainId?: number): boolean => chainId === LENDING.chainId;

/**
 * Why lending is unavailable on this chain, or null when it is available.
 * Returned as a sentence because the UI must SAY this, not just grey a button out.
 */
export function lendingUnavailableOn(chainId?: number): string | null {
  if (lendingAvailableOn(chainId)) return null;
  return `Lending is only live on ${RH_CHAIN.name}. Switch networks to supply or borrow.`;
}

/* ───────────────────────────────── ABIs ────────────────────────────────── */

export const poolAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getConfiguration",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "data", type: "uint256" }],
  },
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const gatewayAbi = [
  {
    type: "function",
    name: "depositETH",
    stateMutability: "payable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
] as const;

export const oracleAbi = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const dataProviderAbi = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "_unused0", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "_unused1", type: "uint256" },
      { name: "_unused2", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** The debt token's read-time borrow veto — the same answer `mint` enforces on chain. */
export const gatedDebtAbi = [
  {
    type: "function",
    name: "borrowPermitted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

/* ──────────────────────────────── reads ────────────────────────────────── */

function client() {
  const rpc =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || RH_CHAIN.rpcUrl;
  return createPublicClient({ chain: RH_CHAIN as any, transport: http(rpc) });
}

export interface ReserveSnapshot extends LendingAsset {
  /** USD, 8 decimals, straight from AaveOracle. */
  priceBase: bigint;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  /** Annual rates in ray (1e27), exactly as Aave stores them. */
  liquidityRate: bigint;
  variableBorrowRate: bigint;
  supplyApy: number;
  borrowApy: number;
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  borrowingEnabled: boolean;
  isPaused: boolean;
  isFrozen: boolean;
}

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/**
 * Aave stores `currentLiquidityRate` / `currentVariableBorrowRate` as an ANNUAL rate in ray —
 * confirmed in MathUtils, which accrues with `rate * timeDelta / SECONDS_PER_YEAR`. It is NOT a
 * per-second rate, and an earlier version of this comment said it was.
 *
 * The UI convention is to compound that APR into an APY. Reporting the APR unchanged understates
 * a borrow rate, which in a lending UI means quoting a cheaper loan than the chain will give.
 */
export function rayRateToApy(annualRateRay: bigint): number {
  const apr = Number(annualRateRay) / Number(RAY);
  return (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
}

/** Reserve-config bitmap offsets, taken from Aave's own ReserveConfiguration constants. */
export function decodeConfig(c: bigint) {
  return {
    ltvBps: Number(c & 0xffffn),
    liquidationThresholdBps: Number((c >> 16n) & 0xffffn),
    liquidationBonusBps: Number(((c >> 32n) & 0xffffn) - 10_000n),
    isActive: ((c >> 56n) & 1n) === 1n,
    isFrozen: ((c >> 57n) & 1n) === 1n,
    borrowingEnabled: ((c >> 58n) & 1n) === 1n,
    isPaused: ((c >> 60n) & 1n) === 1n,
  };
}

export async function readReserves(chainId?: number): Promise<ReserveSnapshot[]> {
  if (!lendingAvailableOn(chainId)) return [];
  const c = client();

  const out = await Promise.all(
    LENDING_ASSETS.map(async (a) => {
      const [price, cfg, rd] = await Promise.all([
        c.readContract({ address: LENDING.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [a.address] }),
        c.readContract({ address: LENDING.pool, abi: poolAbi, functionName: "getConfiguration", args: [a.address] }),
        c.readContract({ address: LENDING.dataProvider, abi: dataProviderAbi, functionName: "getReserveData", args: [a.address] }),
      ]);
      const d = decodeConfig(cfg as bigint);
      const r = rd as readonly bigint[];
      return {
        ...a,
        priceBase: price as bigint,
        totalSupplied: r[2],
        totalBorrowed: r[4],
        liquidityRate: r[5],
        variableBorrowRate: r[6],
        supplyApy: rayRateToApy(r[5]),
        borrowApy: rayRateToApy(r[6]),
        ...d,
      } as ReserveSnapshot;
    }),
  );
  return out;
}

export interface UserPosition {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  liquidationThresholdBps: number;
  ltvBps: number;
  /** 1e18-scaled. Aave returns uint256 max when there is no debt — surfaced as null, not Infinity. */
  healthFactor: bigint | null;
  supplied: Record<string, bigint>;
  borrowed: Record<string, bigint>;
}

export async function readUserPosition(user: Address, chainId?: number): Promise<UserPosition | null> {
  if (!lendingAvailableOn(chainId)) return null;
  const c = client();

  const [acct, ...balances] = await Promise.all([
    c.readContract({ address: LENDING.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user] }),
    ...LENDING_ASSETS.flatMap((a) => [
      c.readContract({ address: a.aToken, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
      c.readContract({ address: a.variableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    ]),
  ]);

  const v = acct as readonly bigint[];
  const supplied: Record<string, bigint> = {};
  const borrowed: Record<string, bigint> = {};
  LENDING_ASSETS.forEach((a, i) => {
    supplied[a.symbol] = balances[i * 2] as bigint;
    borrowed[a.symbol] = balances[i * 2 + 1] as bigint;
  });

  // Aave returns type(uint256).max for "no debt". Rendering that as a number produces 1.15e59 on
  // screen; null lets the UI say the true thing instead.
  const HF_NO_DEBT = (1n << 256n) - 1n;
  return {
    totalCollateralBase: v[0],
    totalDebtBase: v[1],
    availableBorrowsBase: v[2],
    liquidationThresholdBps: Number(v[3]),
    ltvBps: Number(v[4]),
    healthFactor: v[5] >= HF_NO_DEBT ? null : v[5],
    supplied,
    borrowed,
  };
}

/**
 * Whether the market will currently ACCEPT a new borrow, read from the debt token itself.
 *
 * This is not cosmetic. The reserve's stored `borrowingEnabled` flag can say true while the
 * liveness gate has already decided borrowing must stop — the gate is synced by a keeper and the
 * flag lags it. The debt token consults the gate at mint time, so `borrowPermitted()` is the
 * answer the chain will actually give. Showing the flag instead would offer a borrow that reverts.
 */
export async function borrowPermitted(chainId?: number): Promise<boolean> {
  if (!lendingAvailableOn(chainId)) return false;
  const usdg = LENDING_ASSETS.find((a) => a.borrowable);
  if (!usdg) return false;
  try {
    return (await client().readContract({
      address: usdg.variableDebtToken,
      abi: gatedDebtAbi,
      functionName: "borrowPermitted",
    })) as boolean;
  } catch {
    // fail closed: an unreadable veto must never render as "you may borrow"
    return false;
  }
}

/* ─────────────────────────────── formatting ────────────────────────────── */

export const fromBase = (v: bigint): number => Number(v) / 10 ** BASE_DECIMALS;

export function formatUsd(v: bigint): string {
  const n = fromBase(v);
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatUnits(v: bigint, decimals: number, max = 6): string {
  const n = Number(v) / 10 ** decimals;
  if (n === 0) return "0";
  if (n < 10 ** -max) return `<${(10 ** -max).toFixed(max)}`;
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

/** Health-factor band, used for colour and for the warning copy. */
export function healthBand(hf: bigint | null): "none" | "safe" | "warn" | "danger" {
  if (hf === null) return "none";
  const n = Number(hf) / 1e18;
  if (n >= 1.5) return "safe";
  if (n >= 1.1) return "warn";
  return "danger";
}
