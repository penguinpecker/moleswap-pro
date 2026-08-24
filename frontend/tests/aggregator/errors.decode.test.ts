/**
 * errors.decode.test.ts — the plain-language decoder is only worth anything if (a) its registry is the
 * contracts' actual error set and (b) the selectors it matches are derived, never typed.
 *
 * 1. PARITY WITH SOURCES. Every registry must equal the `error X(...)` declarations in the contract it claims
 *    to cover — src/MoleRouter.sol, src/MoleHook.sol, lib/v4-core/src (non-test), and the vault trio
 *    src/MolePositions.sol, src/libraries/ZapLogic.sol and src/MoleQueue.sol. Add an error to a contract
 *    without a sentence here and this goes red; keep a sentence for an error that no longer exists and it goes
 *    red too. The vault cases exist because their absence is what let the whole deposit surface ship
 *    undecodable: the router case caught a missing router error the day it was added, and nothing was watching
 *    MolePositions, MoleQueue or ZapLogic at all.
 * 2. ROUND TRIP. Every registry entry, encoded with viem from its ABI and decoded back, names itself and carries
 *    a sentence — no selector is hand-typed anywhere in the pipeline.
 * 3. THE WRAP. v4 bubbles hook and token failures as ERC-7751 WrappedError; the inner reason must surface.
 * 4. COLLIDING SELECTORS. `DeadlinePassed()`, `TransferFailed()`, `NotPoolManager()`, `NotUpgradeAdmin()`,
 *    `OwnerRequired()` and `UnexpectedCallback()` are declared by more than one of these contracts and are the same four bytes on the
 *    wire. Default order must keep every swap message exactly as it was; `prefer` must be able to claim them
 *    for the contract the caller actually called.
 * 5. THE THROWN SHAPES. viem errors, raw JSON-RPC errors, wallet rejections and transport failures each land in
 *    their own bucket, never in each other's.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { encodeErrorResult, toFunctionSelector, encodeAbiParameters, type Hex } from "viem";
import {
  ROUTER_ERROR_ABI,
  HOOK_ERROR_ABI,
  V4_ERROR_ABI,
  ERC20_ERROR_ABI,
  VAULT_ERROR_ABI,
  ZAP_ERROR_ABI,
  QUEUE_ERROR_ABI,
  decodeRevertData,
  decodeSwapFailure,
  extractRevertData,
} from "../../lib/aggregator/errors";
import { ARC_CHAIN, RH_CHAIN } from "../../lib/chain/chains";

const ROOT = path.resolve(process.cwd(), "..");

/* ----------------------------------------------------------------------------- source parsing */

/** `error Name(type name, type name);` → "Name(type,type)". Handles multi-line declarations. */
function errorsInSource(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\berror\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const params = m[2]!
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split(/\s+/)[0]!); // type first, name optional
    out.add(`${m[1]}(${params.join(",")})`);
  }
  return out;
}

function walkSol(dir: string, acc: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "test") continue;
      walkSol(p, acc);
    } else if (ent.name.endsWith(".sol")) acc.push(p);
  }
  return acc;
}

const canonical = (abi: readonly any[]) =>
  new Set(abi.filter((i) => i.type === "error").map((i) => `${i.name}(${i.inputs.map((x: any) => x.type).join(",")})`));

describe("the registries are the contracts' error sets, derived from the sources", () => {
  it("MoleRouter", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/MoleRouter.sol"), "utf8");
    expect([...canonical(ROUTER_ERROR_ABI)].sort()).toEqual([...errorsInSource(src)].sort());
  });

  it("MoleHook", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/MoleHook.sol"), "utf8");
    expect([...canonical(HOOK_ERROR_ABI)].sort()).toEqual([...errorsInSource(src)].sort());
  });

  it("MolePositions", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/MolePositions.sol"), "utf8");
    expect([...canonical(VAULT_ERROR_ABI)].sort()).toEqual([...errorsInSource(src)].sort());
  });

  it("ZapLogic", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/libraries/ZapLogic.sol"), "utf8");
    expect([...canonical(ZAP_ERROR_ABI)].sort()).toEqual([...errorsInSource(src)].sort());
  });

  it("MoleQueue", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/MoleQueue.sol"), "utf8");
    expect([...canonical(QUEUE_ERROR_ABI)].sort()).toEqual([...errorsInSource(src)].sort());
  });

  it("the vault guards a depositor can actually trip are all covered by name", () => {
    // Named one by one rather than left to the parity check above: these are the ones a person hits by
    // depositing, withdrawing or being rebalanced, and a rename that quietly drops one from the contract
    // would satisfy parity while leaving the UI with nothing to say.
    const vault = canonical(VAULT_ERROR_ABI);
    for (const n of [
      "PoolTooLarge", "SpotTooFarFromTwap", "MintedBelowMinimum", "PositionTooSmall", "PositionTooLarge",
      "RangeWidthOutOfBounds", "RangeTooFarFromTwap", "RecenterTooFar", "WithdrawBelowMinimum",
      "ExceedsMaxAmount", "InsufficientLiquidity", "NoSuchPosition", "PoolNotWhitelisted",
    ]) {
      expect(vault.has(`${n}()`)).toBe(true);
    }
    for (const n of ["SwapOutputBelowMinimum", "NotSelfFunding"]) expect(canonical(ZAP_ERROR_ABI).has(`${n}()`)).toBe(true);
    for (const n of ["OracleTooStale", "InsufficientPoolDepth", "ClearingJumpTooLarge", "ResidualShortFill", "SettleWindowClosed"]) {
      expect(canonical(QUEUE_ERROR_ABI).has(`${n}()`)).toBe(true);
    }
  });

  it("Uniswap v4 core (every non-test source under lib/v4-core/src)", () => {
    const files = walkSol(path.join(ROOT, "lib/v4-core/src"));
    expect(files.length).toBeGreaterThan(20); // the walk found the vendored tree, not an empty dir
    const fromSources = new Set<string>();
    for (const f of files) for (const e of errorsInSource(fs.readFileSync(f, "utf8"))) fromSources.add(e);
    expect([...canonical(V4_ERROR_ABI)].sort()).toEqual([...fromSources].sort());
    // The ones the dossier names by hand are all there.
    for (const n of ["TickLiquidityOverflow", "PriceLimitAlreadyExceeded", "PriceLimitOutOfBounds", "HookCallFailed", "PoolNotInitialized", "CurrencyNotSettled", "ManagerLocked", "SwapAmountCannotBeZero", "AlreadyUnlocked"]) {
      expect([...fromSources].some((s) => s.startsWith(`${n}(`))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------- round trips */

function sampleArg(type: string): unknown {
  if (type === "address") return "0x00000000000000000000000000000000000000a1";
  if (type === "bool") return true;
  if (type === "bytes4") return "0x12345678";
  if (type === "bytes") return "0x";
  if (type === "string") return "x";
  if (type.startsWith("int")) return -42n;
  if (type.startsWith("uint")) return 42n;
  throw new Error(`no sample for ${type}`);
}

/** Same order as the registry's own GROUPS: a colliding selector belongs to the first group that carries it. */
const GROUPS: Array<{ source: string; abi: readonly any[] }> = [
  { source: "router", abi: ROUTER_ERROR_ABI },
  { source: "hook", abi: HOOK_ERROR_ABI },
  { source: "v4", abi: V4_ERROR_ABI },
  { source: "erc20", abi: ERC20_ERROR_ABI },
  { source: "vault", abi: VAULT_ERROR_ABI },
  { source: "zap", abi: ZAP_ERROR_ABI },
  { source: "queue", abi: QUEUE_ERROR_ABI },
];

describe("every registry entry round-trips through encode → decode with a sentence attached", () => {
  for (const g of GROUPS) {
    for (const item of g.abi as any[]) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i: any) => i.type).join(",")})`;
      it(`${g.source}.${item.name}`, () => {
        const args = item.inputs.map((i: any) => sampleArg(i.type));
        const data = encodeErrorResult({ abi: g.abi as any, errorName: item.name, args });
        const d = decodeRevertData(data);
        // A selector that collides across groups is attributed to the first group that carries it.
        const owner = GROUPS.find((x) => canonical(x.abi).has(sig))!.source;
        expect(d.errorName).toBe(item.name);
        expect(d.source).toBe(owner);
        if (item.name !== "WrappedError") expect(d.code).toBe(`${owner}.${item.name}`);
        expect(d.message.length).toBeGreaterThan(15);
        expect(d.message).not.toMatch(/undefined|\[object/);
        expect(d.title).not.toBe(item.name); // a sentence, not the identifier echoed back
        expect(d.raw).toBe(data);
      });
    }
  }

  it("formats amounts in token units when context is given", () => {
    const data = encodeErrorResult({ abi: ROUTER_ERROR_ABI, errorName: "InsufficientOutput", args: [1_234_560n, 2_000_000n] });
    const d = decodeRevertData(data, { tokenOut: { symbol: "USDG", decimals: 6 } });
    expect(d.code).toBe("router.InsufficientOutput");
    expect(d.message).toContain("1.23456 USDG");
    expect(d.message).toContain("2 USDG");
    expect(d.isProtection).toBe(true);
  });
});

/* ------------------------------------------------------------------- the gas token has two names */

describe("the sentences that name the gas token name the chain's own", () => {
  // Robinhood 4663 pays gas in ETH; Arc 5042 pays it in USDC and has no WETH at all. "Top up ETH" is
  // therefore a correct instruction on one chain and a hunt for an asset that does not exist on the other.
  // The symbols are read from the chain registry rather than typed here, for the same reason the selectors
  // are derived: a chain whose gas token is renamed must not leave a stale word behind in a sentence.
  const arc = { native: { symbol: ARC_CHAIN.nativeSymbol, wrapped: null } } as const;
  const nativeFailed = toFunctionSelector("NativeTransferFailed()");

  it("still says ETH when the caller named no chain, word for word", () => {
    // Pinned verbatim: this is what every swap message said before the gas token became a variable, and a
    // caller that passes no context must not notice that it did.
    expect(decodeSwapFailure(new Error("insufficient funds for gas * price + value")).message).toBe(
      "Not enough ETH to pay for gas (or to send with the swap). Top up and retry.",
    );
    expect(decodeRevertData(nativeFailed).message).toBe(
      "The recipient could not receive ETH (it rejects plain transfers). Use a different recipient or receive WETH instead.",
    );
    expect(decodeRevertData(nativeFailed).title).toBe("Could not deliver ETH");
  });

  it("names Arc's gas token on Arc instead of sending someone looking for ETH", () => {
    const gas = decodeSwapFailure(new Error("insufficient funds for gas * price + value"), arc);
    expect(gas.code).toBe("wallet.insufficientFunds");
    expect(gas.title).toBe(`Not enough ${ARC_CHAIN.nativeSymbol}`);
    expect(gas.message).toContain(ARC_CHAIN.nativeSymbol);
    expect(gas.message).not.toMatch(/\bETH\b/);
  });

  it("offers wrapping only where a wrapper exists — naming a native without one withdraws the advice", () => {
    const d = decodeRevertData(nativeFailed, arc);
    expect(d.message).toContain(ARC_CHAIN.nativeSymbol);
    expect(d.message).not.toMatch(/\bW?ETH\b/);
    expect(d.message).not.toMatch(/instead/); // no dangling "or receive  instead"
    // Robinhood does have a wrapper, and a caller that says so still gets the suggestion.
    const rh = decodeRevertData(nativeFailed, { native: { symbol: RH_CHAIN.nativeSymbol, wrapped: "WETH" } });
    expect(rh.message).toContain("receive WETH instead");
  });

  it("no registry sentence hardcodes ETH behind the caller's back", () => {
    // The derivation that keeps this honest: encode every entry in every registry, decode it with Arc's gas
    // token in force, and fail on any title or message that still says ETH. A newly added sentence that types
    // the word rather than asking the context goes red here on the day it lands.
    for (const g of GROUPS) {
      for (const item of g.abi as any[]) {
        if (item.type !== "error") continue;
        const data = encodeErrorResult({ abi: g.abi as any, errorName: item.name, args: item.inputs.map((i: any) => sampleArg(i.type)) });
        const d = decodeRevertData(data, arc);
        expect(`${d.title} ${d.message}`).not.toMatch(/\bW?ETH\b/);
      }
    }
  });
});

/* ------------------------------------------------------------------------- the vault surface */

/** The six the vault declares that MoleRouter declares too — same four bytes, nothing on the wire to separate them. */
const SHARED_WITH_THE_ROUTER = ["DeadlinePassed", "TransferFailed", "NotPoolManager", "NotUpgradeAdmin", "OwnerRequired", "UnexpectedCallback"];

describe("a depositor's reverts read as sentences, and a working guard says it is one", () => {
  const sel = (name: string) => toFunctionSelector(`${name}()`);

  it("the vault guards a deposit or a rebalance can trip are decoded and flagged as protections", () => {
    for (const name of [
      "PoolTooLarge", "SpotTooFarFromTwap", "MintedBelowMinimum", "PositionTooSmall", "PositionTooLarge",
      "RangeWidthOutOfBounds", "RangeTooFarFromTwap", "RecenterTooFar", "WithdrawBelowMinimum", "ExceedsMaxAmount",
      "DwellNotElapsed", "RebalanceTooSoon", "KeeperRevokedForPosition",
    ]) {
      const d = decodeRevertData(sel(name));
      expect(d.code).toBe(`vault.${name}`);
      expect(d.source).toBe("vault");
      expect(d.isProtection).toBe(true);
      expect(d.title).not.toBe(name); // a headline, not the identifier echoed back
      expect(d.message.length).toBeGreaterThan(40);
      expect(d.message).not.toContain("0x"); // no hex leaks into the sentence
    }
  });

  it("the plain mistakes are decoded too, and are NOT dressed up as protections", () => {
    for (const name of ["NoSuchPosition", "InsufficientLiquidity", "PoolNotWhitelisted", "TicksMisordered", "TickNotOnSpacing", "ZeroLiquidity"]) {
      const d = decodeRevertData(sel(name));
      expect(d.code).toBe(`vault.${name}`);
      expect(d.isProtection).toBeFalsy();
      expect(d.message.length).toBeGreaterThan(30);
    }
  });

  it("a queue guard says the money is coming back, because it is", () => {
    for (const name of ["OracleTooStale", "InsufficientPoolDepth", "ClearingJumpTooLarge", "TwapTooFarFromSpot", "ResidualShortFill", "ResidualSwapTooFarFromTwap"]) {
      const d = decodeRevertData(sel(name));
      expect(d.code).toBe(`queue.${name}`);
      expect(d.isProtection).toBe(true);
      // The one fact a participant needs first: an unsettleable batch times out and refunds in kind.
      expect(d.message).toMatch(/in kind/i);
    }
  });

  it("the zap's own two surface; the five it shares with the vault resolve to the vault", () => {
    expect(decodeRevertData(sel("SwapOutputBelowMinimum")).code).toBe("zap.SwapOutputBelowMinimum");
    expect(decodeRevertData(sel("SwapOutputBelowMinimum")).isProtection).toBe(true);
    expect(decodeRevertData(sel("NotSelfFunding")).code).toBe("zap.NotSelfFunding");
    for (const shared of ["ZeroLiquidity", "DepositAccruedFees", "RebalanceNotSelfFunding", "EjectionTooLarge"]) {
      expect(decodeRevertData(sel(shared)).source).toBe("vault");
    }
  });

  it("nothing the vault, the zap or the queue added shadows a swap-layer selector by accident", () => {
    for (const abi of [VAULT_ERROR_ABI, ZAP_ERROR_ABI, QUEUE_ERROR_ABI] as any[]) {
      for (const item of abi) {
        if (item.type !== "error" || item.inputs.length !== 0) continue;
        const d = decodeRevertData(sel(item.name));
        if (["vault", "zap", "queue"].includes(d.source)) continue;
        // The only escape: a signature MoleRouter itself declares, which keeps the router's wording.
        expect(SHARED_WITH_THE_ROUTER).toContain(item.name);
        expect(d.source).toBe("router");
      }
    }
  });

  it("a shared selector keeps its swap reading by default and follows `prefer` when the caller names its contract", () => {
    for (const name of SHARED_WITH_THE_ROUTER) {
      expect(decodeRevertData(sel(name)).code).toBe(`router.${name}`);
      expect(decodeRevertData(sel(name), { prefer: "vault" }).code).toBe(`vault.${name}`);
      expect(decodeRevertData(sel(name), { prefer: "vault" }).message).not.toContain("router");
    }
    for (const name of ["TransferFailed", "NotPoolManager", "NotUpgradeAdmin"]) {
      expect(decodeRevertData(sel(name), { prefer: "queue" }).code).toBe(`queue.${name}`);
    }
    // `prefer` only reorders the lookup: an error a single contract declares is unaffected either way, and
    // an argument-carrying router error still decodes its arguments with a vault preference in force.
    expect(decodeRevertData(sel("PoolTooLarge"), { prefer: "queue" }).code).toBe("vault.PoolTooLarge");
    const belowMin = encodeErrorResult({ abi: ROUTER_ERROR_ABI, errorName: "InsufficientOutput", args: [1_000n, 2_000n] });
    const d = decodeRevertData(belowMin, { prefer: "vault", tokenOut: { symbol: "USDC", decimals: 6 } });
    expect(d.code).toBe("router.InsufficientOutput");
    expect(d.message).toContain("0.001 USDC");
  });

  it("an unknown preference is ignored rather than emptying the lookup", () => {
    expect(decodeRevertData(sel("PoolTooLarge"), { prefer: "wallet" }).code).toBe("vault.PoolTooLarge");
  });
});

describe("errors that carry values render them", () => {
  it("today none of the three contracts declares one — read from the sources, not assumed", () => {
    // Load-bearing for every sentence above: they are all self-contained because there is nothing to
    // interpolate. When a contract grows `error PoolTooLarge(uint128 have, uint128 cap)` this goes red and
    // sends whoever added it to the case below, which is where the value has to start being shown.
    const withArgs: string[] = [];
    for (const f of ["src/MolePositions.sol", "src/libraries/ZapLogic.sol", "src/MoleQueue.sol"]) {
      for (const sig of errorsInSource(fs.readFileSync(path.join(ROOT, f), "utf8"))) {
        if (!sig.endsWith("()")) withArgs.push(`${f}: ${sig}`);
      }
    }
    expect(withArgs).toEqual([]);
  });

  it("and any that does must put its values in the sentence, the way the router's already do", () => {
    // The mechanism is proven live by MoleRouter.PathSumMismatch / InsufficientOutput above; this arms the
    // same requirement for the vault trio so a new one cannot ship as a title with the numbers dropped.
    for (const abi of [VAULT_ERROR_ABI, ZAP_ERROR_ABI, QUEUE_ERROR_ABI] as any[]) {
      for (const item of abi) {
        if (item.type !== "error" || item.inputs.length === 0) continue;
        const args = item.inputs.map((i: any) => sampleArg(i.type));
        const d = decodeRevertData(encodeErrorResult({ abi, errorName: item.name, args }));
        expect(d.args?.length).toBe(item.inputs.length);
        for (const a of args) {
          expect(d.message).toContain(typeof a === "string" && a.length > 12 ? a.slice(-4) : String(a));
        }
      }
    }
  });
});

/* ---------------------------------------------------------------------------------- the wrap */

describe("ERC-7751 WrappedError is unwrapped to the inner reason", () => {
  const HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4";
  const wrap = (reason: Hex, detailsName: string) =>
    encodeErrorResult({
      abi: V4_ERROR_ABI,
      errorName: "WrappedError",
      args: [HOOK, toFunctionSelector("beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)"), reason, toFunctionSelector(`${detailsName}()`)],
    });

  it("a MoleHook guard inside HookCallFailed reads as the guard, marked as a protection", () => {
    const inner = encodeErrorResult({ abi: HOOK_ERROR_ABI, errorName: "InsufficientObservations" });
    const d = decodeRevertData(wrap(inner, "HookCallFailed"));
    expect(d.code).toBe("v4.HookCallFailed");
    expect(d.source).toBe("hook");
    expect(d.inner?.code).toBe("hook.InsufficientObservations");
    expect(d.isProtection).toBe(true);
    expect(d.title).toBe("Hook rejected the swap");
    expect(d.message).toContain("price oracle has too little history");
  });

  it("a token's Error(string) inside ERC20TransferFailed reads as the token's reason", () => {
    const inner = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "r" }] }], errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] });
    const d = decodeRevertData(wrap(inner, "ERC20TransferFailed"));
    expect(d.code).toBe("v4.ERC20TransferFailed");
    expect(d.title).toBe("Token transfer out of the pool failed");
    expect(d.inner?.source).toBe("erc20");
    expect(d.message).toMatch(/exceeds balance|Insufficient balance|Not enough token balance/i);
  });

  it("an empty inner reason still names the v4 context", () => {
    const d = decodeRevertData(wrap("0x", "NativeTransferFailed"));
    expect(d.code).toBe("v4.NativeTransferFailed");
    expect(d.inner).toBeUndefined();
    expect(d.message).toContain("could not send ETH");
  });
});

/* ------------------------------------------------------------------------- builtins and unknowns */

describe("Solidity builtins, strings and the unknown", () => {
  const str = (s: string) => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "r" }] }], errorName: "Error", args: [s] });
  const panic = (code: bigint) => encodeErrorResult({ abi: [{ type: "error", name: "Panic", inputs: [{ type: "uint256", name: "c" }] }], errorName: "Panic", args: [code] });

  it("maps the v3 pool and token strings", () => {
    expect(decodeRevertData(str("STF")).source).toBe("erc20");
    expect(decodeRevertData(str("SPL")).title).toBe("Price already past the limit");
    expect(decodeRevertData(str("IIA")).title).toBe("Pool under-paid");
    expect(decodeRevertData(str("ERC20: insufficient allowance")).title).toBe("Allowance too low");
    expect(decodeRevertData(str("Pausable: paused")).title).toBe("Token paused");
  });

  it("quotes an unknown string rather than hiding it", () => {
    const d = decodeRevertData(str("weird reason"));
    expect(d.code).toBe("string.unknown");
    expect(d.message).toContain("weird reason");
  });

  it("names the panic code", () => {
    const d = decodeRevertData(panic(0x11n));
    expect(d.code).toBe("evm.panic.0x11");
    expect(d.message).toMatch(/overflow/);
    expect(decodeRevertData(panic(0x12n)).code).toBe("evm.panic.0x12");
  });

  it("empty data is 'no reason', not a crash", () => {
    expect(decodeRevertData("0x").code).toBe("evm.empty");
    expect(decodeRevertData(undefined).code).toBe("evm.empty");
    expect(decodeRevertData("").code).toBe("evm.empty");
  });

  it("an unknown selector is reported with its selector and raw data", () => {
    const d = decodeRevertData("0xdeadbeef00000000000000000000000000000000000000000000000000000000000000ff");
    expect(d.code).toBe("unknown.0xdeadbeef");
    expect(d.raw.startsWith("0xdeadbeef")).toBe(true);
  });
});

/* --------------------------------------------------------------------------- the thrown shapes */

describe("decodeSwapFailure digs the bytes out of whatever was thrown", () => {
  const deadline = encodeErrorResult({ abi: ROUTER_ERROR_ABI, errorName: "DeadlinePassed" });

  it("viem ContractFunctionExecutionError → cause.raw", () => {
    const err = Object.assign(new Error("The contract function reverted."), { cause: Object.assign(new Error("x"), { raw: deadline }) });
    expect(decodeSwapFailure(err).code).toBe("router.DeadlinePassed");
  });

  it("raw JSON-RPC error object → .data", () => {
    expect(decodeSwapFailure({ code: 3, message: "execution reverted", data: deadline }).code).toBe("router.DeadlinePassed");
    expect(decodeSwapFailure({ code: 3, message: "execution reverted", data: { data: deadline } }).code).toBe("router.DeadlinePassed");
  });

  it("revert hex embedded in a message", () => {
    expect(extractRevertData(new Error(`execution reverted: ${deadline}`))).toBe(deadline);
  });

  it("wallet rejection / insufficient funds / transport / unsupported land in their own buckets", () => {
    expect(decodeSwapFailure(new Error("User rejected the request.")).code).toBe("wallet.rejected");
    expect(decodeSwapFailure(new Error("insufficient funds for gas * price + value")).code).toBe("wallet.insufficientFunds");
    expect(decodeSwapFailure(new TypeError("fetch failed")).code).toBe("transport.unavailable");
    expect(decodeSwapFailure({ code: 429, message: "Too Many Requests" }).code).toBe("transport.unavailable");
    expect(decodeSwapFailure({ code: -32602, message: "invalid argument 2: json: cannot unmarshal" }).code).toBe("transport.unsupported");
  });

  it("passes an already-decoded failure through unchanged", () => {
    const d = decodeRevertData(deadline);
    expect(decodeSwapFailure(d)).toBe(d);
  });

  it("a revert with no data is 'reverted', never 'no liquidity'", () => {
    const d = decodeSwapFailure(new Error("execution reverted"));
    expect(d.code).toBe("evm.reverted");
    expect(d.message).not.toMatch(/liquidity/i);
  });

  it("sanity: the hex the tests produce is what viem derives from the ABI, not a typed constant", () => {
    expect(deadline).toBe(toFunctionSelector("DeadlinePassed()"));
    expect(encodeAbiParameters([], []).length).toBe(2); // viem is wired (no-arg encodes to "0x")
  });
});
