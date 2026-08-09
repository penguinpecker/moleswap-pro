/**
 * abi.test.ts — the minimal ABIs must encode EXACTLY the contract's shapes.
 *
 * ABI bugs are silent: a uint24/int24 swap or a reordered PoolKey tuple still
 * encodes, still sends, and simply calls the contract with garbage (or hashes
 * to a pool id that does not exist). These tests pin the field order and types.
 */

import { describe, it, expect } from "vitest";
import { molePositionsAbi, erc20Abi } from "../../lib/mole/abi";

type AbiParam = {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly AbiParam[];
};
type AbiFn = {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
};

function fn(abi: readonly AbiFn[], name: string): AbiFn {
  const entry = abi.find((e) => e.type === "function" && e.name === name);
  if (!entry) throw new Error(`ABI is missing function ${name}`);
  return entry;
}

/** [name, type] pairs in declaration order — order IS the encoding. */
function shape(params: readonly AbiParam[] | undefined): Array<[string, string]> {
  return (params ?? []).map((p) => [p.name ?? "", p.type]);
}

const POOL_KEY_SHAPE: Array<[string, string]> = [
  ["currency0", "address"],
  ["currency1", "address"],
  ["fee", "uint24"],
  ["tickSpacing", "int24"],
  ["hooks", "address"],
];

describe("every ABI entry is a well-formed function fragment", () => {
  const all = [...molePositionsAbi, ...erc20Abi] as readonly AbiFn[];
  it("has type/name/stateMutability/inputs/outputs on every entry", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(e.type).toBe("function");
      expect(typeof e.name).toBe("string");
      expect(["pure", "view", "nonpayable", "payable"]).toContain(e.stateMutability);
      expect(Array.isArray(e.inputs)).toBe(true);
      expect(Array.isArray(e.outputs)).toBe(true);
    }
  });
});

describe("ATTACK: PoolKey tuple order is the abi-encoding order", () => {
  it("open()'s key tuple is (currency0, currency1, fee uint24, tickSpacing int24, hooks) — exactly", () => {
    const open = fn(molePositionsAbi as readonly AbiFn[], "open");
    const key = open.inputs?.[0];
    expect(key?.type).toBe("tuple");
    expect(shape(key?.components)).toEqual(POOL_KEY_SHAPE);
  });

  it("zapOpen()'s nested key tuple matches the same shape", () => {
    const zap = fn(molePositionsAbi as readonly AbiFn[], "zapOpen");
    const z = zap.inputs?.[0];
    expect(z?.type).toBe("tuple");
    const key = z?.components?.[0];
    expect(key?.name).toBe("key");
    expect(key?.type).toBe("tuple");
    expect(shape(key?.components)).toEqual(POOL_KEY_SHAPE);
  });

  it("fee is uint24 and tickSpacing is int24 — a swap of the two still encodes but corrupts every call", () => {
    const open = fn(molePositionsAbi as readonly AbiFn[], "open");
    const comps = open.inputs?.[0]?.components ?? [];
    expect(comps.find((c) => c.name === "fee")?.type).toBe("uint24");
    expect(comps.find((c) => c.name === "tickSpacing")?.type).toBe("int24");
  });
});

describe("MolePositions write surface", () => {
  it("open(key, int24, int24, uint128, uint256, uint256, uint256) -> uint256 id", () => {
    const open = fn(molePositionsAbi as readonly AbiFn[], "open");
    expect(shape(open.inputs).slice(1)).toEqual([
      ["tickLower", "int24"],
      ["tickUpper", "int24"],
      ["liquidity", "uint128"],
      ["amount0Max", "uint256"],
      ["amount1Max", "uint256"],
      ["deadline", "uint256"],
    ]);
    expect(shape(open.outputs)).toEqual([["id", "uint256"]]);
    expect(open.stateMutability).toBe("nonpayable");
  });

  it("zapOpen tuple: (key, tickLower int24, tickUpper int24, zeroForOne bool, amountIn uint256, swapAmount uint256, minLiquidity uint128, amountOutMin uint256) + deadline", () => {
    // amountOutMin is the REAL slippage bound (ZapLogic.ZapParams field 8) — minLiquidity alone is not
    // protection on a one-sided zap. The ABI MUST carry it or the encoded calldata is short a field and
    // the zap reverts. See src/libraries/ZapLogic.sol.
    const zap = fn(molePositionsAbi as readonly AbiFn[], "zapOpen");
    const z = zap.inputs?.[0];
    expect(shape(z?.components).slice(1)).toEqual([
      ["tickLower", "int24"],
      ["tickUpper", "int24"],
      ["zeroForOne", "bool"],
      ["amountIn", "uint256"],
      ["swapAmount", "uint256"],
      ["minLiquidity", "uint128"],
      ["amountOutMin", "uint256"],
    ]);
    expect(shape(zap.inputs).slice(1)).toEqual([["deadline", "uint256"]]);
    expect(shape(zap.outputs)).toEqual([["id", "uint256"]]);
  });

  it("withdraw takes (uint256 id, uint128 liquidityToRemove); withdrawAll takes only the id", () => {
    const withdraw = fn(molePositionsAbi as readonly AbiFn[], "withdraw");
    expect(shape(withdraw.inputs)).toEqual([
      ["id", "uint256"],
      ["liquidityToRemove", "uint128"],
    ]);
    const withdrawAll = fn(molePositionsAbi as readonly AbiFn[], "withdrawAll");
    expect(shape(withdrawAll.inputs)).toEqual([["id", "uint256"]]);
  });

  it("setKeeperRevoked takes (uint256 id, bool revoked)", () => {
    const skr = fn(molePositionsAbi as readonly AbiFn[], "setKeeperRevoked");
    expect(shape(skr.inputs)).toEqual([
      ["id", "uint256"],
      ["revoked", "bool"],
    ]);
  });
});

describe("MolePositions view surface", () => {
  it("getPosition returns the Position tuple with int24 ticks, uint128 liquidity, uint64 block fields — in storage order", () => {
    const gp = fn(molePositionsAbi as readonly AbiFn[], "getPosition");
    expect(shape(gp.inputs)).toEqual([["id", "uint256"]]);
    const out = gp.outputs?.[0];
    expect(out?.type).toBe("tuple");
    expect(shape(out?.components)).toEqual([
      ["owner", "address"],
      ["poolId", "bytes32"],
      ["tickLower", "int24"],
      ["tickUpper", "int24"],
      ["liquidity", "uint128"],
      ["openedAtL1Block", "uint64"],
      ["lastRebalancedAt", "uint64"],
    ]);
    expect(gp.stateMutability).toBe("view");
  });

  it("positionsOf(address) -> uint256[] (the enumerator is positionsOf, not ownerPositions)", () => {
    const po = fn(molePositionsAbi as readonly AbiFn[], "positionsOf");
    expect(shape(po.inputs)).toEqual([["owner", "address"]]);
    expect(po.outputs?.[0]?.type).toBe("uint256[]");
    expect(
      (molePositionsAbi as readonly AbiFn[]).find((e) => e.name === "ownerPositions")
    ).toBeUndefined();
  });

  it("isWhitelisted takes bytes32 poolId; keeperRevoked takes uint256 id; performanceFeeBps returns uint16", () => {
    expect(shape(fn(molePositionsAbi as readonly AbiFn[], "isWhitelisted").inputs)).toEqual([
      ["poolId", "bytes32"],
    ]);
    expect(shape(fn(molePositionsAbi as readonly AbiFn[], "keeperRevoked").inputs)).toEqual([
      ["id", "uint256"],
    ]);
    expect(fn(molePositionsAbi as readonly AbiFn[], "performanceFeeBps").outputs?.[0]?.type).toBe(
      "uint16"
    );
  });
});

describe("ERC-20 minimal surface", () => {
  it("has exactly the deposit-flow needs: approve/allowance/balanceOf/decimals", () => {
    const names = (erc20Abi as readonly AbiFn[]).map((e) => e.name).sort();
    expect(names).toEqual(["allowance", "approve", "balanceOf", "decimals"]);
  });

  it("decimals() returns uint8 — the UI READS decimals, it never assumes them", () => {
    const dec = fn(erc20Abi as readonly AbiFn[], "decimals");
    expect(dec.stateMutability).toBe("view");
    expect(shape(dec.inputs)).toEqual([]);
    expect(dec.outputs?.[0]?.type).toBe("uint8");
  });

  it("ATTACK: no symbol()/name() in the ABI — on this chain, resolving tokens by symbol finds 18-decimal fakes", () => {
    expect((erc20Abi as readonly AbiFn[]).find((e) => e.name === "symbol")).toBeUndefined();
    expect((erc20Abi as readonly AbiFn[]).find((e) => e.name === "name")).toBeUndefined();
  });

  it("approve(spender, amount uint256) -> bool", () => {
    const approve = fn(erc20Abi as readonly AbiFn[], "approve");
    expect(shape(approve.inputs)).toEqual([
      ["spender", "address"],
      ["amount", "uint256"],
    ]);
    expect(approve.outputs?.[0]?.type).toBe("bool");
  });
});
