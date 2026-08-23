/**
 * errors.decode.test.ts — the plain-language decoder is only worth anything if (a) its registry is the
 * contracts' actual error set and (b) the selectors it matches are derived, never typed.
 *
 * 1. PARITY WITH SOURCES. The router/hook/v4 registries must equal the `error X(...)` declarations in
 *    src/MoleRouter.sol, src/MoleHook.sol and lib/v4-core/src (non-test). Add an error to a contract without a
 *    sentence here and this goes red; keep a sentence for an error that no longer exists and it goes red too.
 * 2. ROUND TRIP. Every registry entry, encoded with viem from its ABI and decoded back, names itself and carries
 *    a sentence — no selector is hand-typed anywhere in the pipeline.
 * 3. THE WRAP. v4 bubbles hook and token failures as ERC-7751 WrappedError; the inner reason must surface.
 * 4. THE THROWN SHAPES. viem errors, raw JSON-RPC errors, wallet rejections and transport failures each land in
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
  decodeRevertData,
  decodeSwapFailure,
  extractRevertData,
} from "../../lib/aggregator/errors";

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

const GROUPS: Array<{ source: string; abi: readonly any[] }> = [
  { source: "router", abi: ROUTER_ERROR_ABI },
  { source: "hook", abi: HOOK_ERROR_ABI },
  { source: "v4", abi: V4_ERROR_ABI },
  { source: "erc20", abi: ERC20_ERROR_ABI },
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
