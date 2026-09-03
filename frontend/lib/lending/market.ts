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

/**
 * Which assets the lend page LEADS with.
 *
 * The market's product is: post a tokenised equity as collateral, borrow dollars. USDG is on this list
 * not as a headline asset but because it is the ONLY thing that can be borrowed — a lending page with
 * nothing borrowable is a page that cannot lend. USDe is deliberately off it: it is borrowable, listed
 * at 75/80 with a reserve factor of ZERO and $1M caps, against roughly no liquidatable depth on this
 * chain, so a depeg would leave unbacked debt with no first-loss buffer. Leaving it un-listed on the
 * frontend does not delist it on chain; it stops the UI inviting deposits into the market's worst risk.
 *
 * WETH is off the list too — it is collateral-only and borrowing in it is disabled — but see
 * `visibleAssets`, which always re-adds anything the connected wallet actually holds. A reserve
 * disappearing from the page must never make somebody's funds unreachable.
 */
/** Dollar-denominated reserves, for copy that needs to distinguish them from the equities. */
export const STABLE_SYMBOLS = new Set(["USDG", "USDe"]);

export const FOCUSED_SYMBOLS = ["NVDA", "SPY", "TSLA", "AAPL", "MSFT", "USDG"] as const;

export interface LendingAsset {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly aToken: Address;
  readonly variableDebtToken: Address;
  /**
   * False for the collateral-only reserves. WETH and the five equities are all listed this way:
   * they can be supplied and borrowed AGAINST, but no debt can be opened IN them.
   */
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
  {
    symbol: "NVDA",
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    decimals: 18,
    aToken: "0xecD6c71Ad8928566f7cBDA9c56E21Cef247aCF1c",
    variableDebtToken: "0xDD50bE0d63eb79A6cCB4752865e811f8bF7A5606",
    borrowable: false,
    isWrappedNative: false,
  },
  {
    symbol: "SPY",
    address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    decimals: 18,
    aToken: "0x582511243F73D612370A557344cCf0dd18a8C9eB",
    variableDebtToken: "0x5f5e5117EbEf1BD7220e05b657a2051cBf465085",
    borrowable: false,
    isWrappedNative: false,
  },
  {
    symbol: "TSLA",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    decimals: 18,
    aToken: "0xC865caa46BcBA3CF9916a28178491f2BA6CF1848",
    variableDebtToken: "0x226De3FC9d437667686729125871e4d33a8574CE",
    borrowable: false,
    isWrappedNative: false,
  },
  {
    symbol: "AAPL",
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    decimals: 18,
    aToken: "0xBE0a6fa0db5D28644D327f97FfBB1196C80Fb8Fc",
    variableDebtToken: "0x4DbAD2f27803673Fe4ecd24E9362AE615e3fC6b7",
    borrowable: false,
    isWrappedNative: false,
  },
  {
    symbol: "MSFT",
    address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    decimals: 18,
    aToken: "0x215a1A54C9206009B7857a9f8135fB38a567d4aC",
    variableDebtToken: "0x56AB3493CDe382917f18d58fD107f37c758Ee0F8",
    borrowable: false,
    isWrappedNative: false,
  },
  {
    symbol: "USDe",
    address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
    decimals: 18,
    aToken: "0xa7992F0a0C0f399B8e11bDB08383Ca65e31B18e7",
    variableDebtToken: "0x35D22AE3c9884f1132dd6fCA633bED54547BA2f7",
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

/**
 * Every custom error the Pool (and the gateway, which calls the Pool) can revert with: Aave v3.7's
 * Errors.sol verbatim, plus the two the liveness-gated debt token adds. `simulateContract` can only NAME
 * a revert whose signature is in the ABI it was handed; without these, `BorrowingHalted`,
 * `CollateralCannotCoverNewBorrow`, a cap hit and a frozen reserve all surfaced as a raw selector, and
 * the sentence `readable()` in actions.ts promises never matched anything.
 *
 * Generated from upstream/aave-v3-origin Errors.sol (85 errors) — regenerate rather than hand-edit.
 */
export const lendingErrorsAbi = [
  { type: "error", name: "CallerNotPoolAdmin", inputs: [] },
  { type: "error", name: "CallerNotPoolOrEmergencyAdmin", inputs: [] },
  { type: "error", name: "CallerNotRiskOrPoolAdmin", inputs: [] },
  { type: "error", name: "CallerNotAssetListingOrPoolAdmin", inputs: [] },
  { type: "error", name: "AddressesProviderNotRegistered", inputs: [] },
  { type: "error", name: "InvalidAddressesProviderId", inputs: [] },
  { type: "error", name: "NotContract", inputs: [] },
  { type: "error", name: "CallerNotPoolConfigurator", inputs: [] },
  { type: "error", name: "CallerNotAToken", inputs: [] },
  { type: "error", name: "InvalidAddressesProvider", inputs: [] },
  { type: "error", name: "InvalidFlashloanExecutorReturn", inputs: [] },
  { type: "error", name: "ReserveAlreadyAdded", inputs: [] },
  { type: "error", name: "NoMoreReservesAllowed", inputs: [] },
  { type: "error", name: "EModeCategoryReserved", inputs: [] },
  { type: "error", name: "ReserveLiquidityNotZero", inputs: [] },
  { type: "error", name: "FlashloanPremiumInvalid", inputs: [] },
  { type: "error", name: "InvalidReserveParams", inputs: [] },
  { type: "error", name: "InvalidEmodeCategoryParams", inputs: [] },
  { type: "error", name: "CallerMustBePool", inputs: [] },
  { type: "error", name: "InvalidMintAmount", inputs: [] },
  { type: "error", name: "InvalidBurnAmount", inputs: [] },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "ReserveInactive", inputs: [] },
  { type: "error", name: "ReserveFrozen", inputs: [] },
  { type: "error", name: "ReservePaused", inputs: [] },
  { type: "error", name: "BorrowingNotEnabled", inputs: [] },
  { type: "error", name: "NotEnoughAvailableUserBalance", inputs: [] },
  { type: "error", name: "InvalidInterestRateModeSelected", inputs: [] },
  { type: "error", name: "HealthFactorLowerThanLiquidationThreshold", inputs: [] },
  { type: "error", name: "CollateralCannotCoverNewBorrow", inputs: [] },
  { type: "error", name: "NoDebtOfSelectedType", inputs: [] },
  { type: "error", name: "NoExplicitAmountToRepayOnBehalf", inputs: [] },
  { type: "error", name: "UnderlyingBalanceZero", inputs: [] },
  { type: "error", name: "HealthFactorNotBelowThreshold", inputs: [] },
  { type: "error", name: "CollateralCannotBeLiquidated", inputs: [] },
  { type: "error", name: "SpecifiedCurrencyNotBorrowedByUser", inputs: [] },
  { type: "error", name: "InconsistentFlashloanParams", inputs: [] },
  { type: "error", name: "BorrowCapExceeded", inputs: [] },
  { type: "error", name: "SupplyCapExceeded", inputs: [] },
  { type: "error", name: "LtvValidationFailed", inputs: [] },
  { type: "error", name: "InconsistentEModeCategory", inputs: [] },
  { type: "error", name: "ReserveAlreadyInitialized", inputs: [] },
  { type: "error", name: "UserHasAssetWithZeroLtv", inputs: [] },
  { type: "error", name: "InvalidLtv", inputs: [] },
  { type: "error", name: "InvalidLiquidationThreshold", inputs: [] },
  { type: "error", name: "InvalidLiquidationBonus", inputs: [] },
  { type: "error", name: "InvalidDecimals", inputs: [] },
  { type: "error", name: "InvalidReserveFactor", inputs: [] },
  { type: "error", name: "InvalidBorrowCap", inputs: [] },
  { type: "error", name: "InvalidSupplyCap", inputs: [] },
  { type: "error", name: "InvalidLiquidationProtocolFee", inputs: [] },
  { type: "error", name: "InvalidReserveIndex", inputs: [] },
  { type: "error", name: "AclAdminCannotBeZero", inputs: [] },
  { type: "error", name: "InconsistentParamsLength", inputs: [] },
  { type: "error", name: "ZeroAddressNotValid", inputs: [] },
  { type: "error", name: "InvalidExpiration", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "OperationNotSupported", inputs: [] },
  { type: "error", name: "AssetNotListed", inputs: [] },
  { type: "error", name: "InvalidOptimalUsageRatio", inputs: [] },
  { type: "error", name: "UnderlyingCannotBeRescued", inputs: [] },
  { type: "error", name: "AddressesProviderAlreadyAdded", inputs: [] },
  { type: "error", name: "PoolAddressesDoNotMatch", inputs: [] },
  { type: "error", name: "ReserveDebtNotZero", inputs: [] },
  { type: "error", name: "FlashloanDisabled", inputs: [] },
  { type: "error", name: "InvalidMaxRate", inputs: [] },
  { type: "error", name: "WithdrawToAToken", inputs: [] },
  { type: "error", name: "SupplyToAToken", inputs: [] },
  { type: "error", name: "Slope2MustBeGteSlope1", inputs: [] },
  { type: "error", name: "CallerNotRiskOrPoolOrEmergencyAdmin", inputs: [] },
  { type: "error", name: "LiquidationGraceSentinelCheckFailed", inputs: [] },
  { type: "error", name: "InvalidGracePeriod", inputs: [] },
  { type: "error", name: "InvalidFreezeState", inputs: [] },
  { type: "error", name: "InvalidLtvzeroState", inputs: [] },
  { type: "error", name: "NotBorrowableInEMode", inputs: [] },
  { type: "error", name: "CallerNotUmbrella", inputs: [] },
  { type: "error", name: "ReserveNotInDeficit", inputs: [] },
  { type: "error", name: "MustNotLeaveDust", inputs: [] },
  { type: "error", name: "UserCannotHaveDebt", inputs: [] },
  { type: "error", name: "SelfLiquidation", inputs: [] },
  { type: "error", name: "CallerNotPositionManager", inputs: [] },
  { type: "error", name: "InvalidCollateralInEmode", inputs: [{ name: "reserve", type: "address" }, { name: "categoryId", type: "uint256" }] },
  { type: "error", name: "InvalidDebtInEmode", inputs: [{ name: "reserve", type: "address" }, { name: "categoryId", type: "uint256" }] },
  { type: "error", name: "MustBeEmodeCollateral", inputs: [{ name: "reserve", type: "address" }, { name: "categoryId", type: "uint256" }] },
  { type: "error", name: "BorrowingHalted", inputs: [] },
  { type: "error", name: "LivenessGateUnreadable", inputs: [] },
] as const;

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
  ...lendingErrorsAbi,
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
  ...lendingErrorsAbi,
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
  /**
   * What the wallet actually HOLDS of each underlying, which is a different question from what it
   * has supplied and is the one that decides whether a supply can succeed at all. Without it the
   * UI offered a Supply button on six reserves the wallet held none of: the button enabled, the
   * transaction reverted in the wallet, and nothing on the page had said why.
   */
  walletBalance: Record<string, bigint>;
}

export async function readUserPosition(user: Address, chainId?: number): Promise<UserPosition | null> {
  if (!lendingAvailableOn(chainId)) return null;
  const c = client();

  const [acct, ...balances] = await Promise.all([
    c.readContract({ address: LENDING.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user] }),
    ...LENDING_ASSETS.flatMap((a) => [
      c.readContract({ address: a.aToken, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
      c.readContract({ address: a.variableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
      // What the wallet can actually SUPPLY. The native reserve is funded through the gateway from ETH,
      // so its answer is the ETH balance — reading WETH here told a wallet holding ETH "You hold no ETH"
      // and disabled Supply on the market's main collateral.
      a.isWrappedNative
        ? c.getBalance({ address: user })
        : c.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    ]),
  ]);

  const v = acct as readonly bigint[];
  const supplied: Record<string, bigint> = {};
  const borrowed: Record<string, bigint> = {};
  const walletBalance: Record<string, bigint> = {};
  LENDING_ASSETS.forEach((a, i) => {
    supplied[a.symbol] = balances[i * 3] as bigint;
    borrowed[a.symbol] = balances[i * 3 + 1] as bigint;
    walletBalance[a.symbol] = balances[i * 3 + 2] as bigint;
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
    walletBalance,
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

/**
 * The reserves the page should show, in order.
 *
 * The focused set, PLUS any reserve where this wallet has a supplied balance, a debt, or tokens in hand.
 * That second half is the safety property: hiding a reserve is a presentation choice, but hiding one
 * somebody has funds in would take away their Withdraw and Repay buttons and strand them. A user with
 * ETH supplied keeps seeing ETH, whatever the page leads with.
 */
export function visibleAssets(pos: UserPosition | null): readonly LendingAsset[] {
  const focused = new Set<string>(FOCUSED_SYMBOLS);
  return LENDING_ASSETS.filter((a) => {
    if (focused.has(a.symbol)) return true;
    if (!pos) return false;
    return (
      (pos.supplied[a.symbol] ?? 0n) > 0n ||
      (pos.borrowed[a.symbol] ?? 0n) > 0n ||
      (pos.walletBalance[a.symbol] ?? 0n) > 0n
    );
  });
}
