import { keccak256, encodeAbiParameters, type Address, type Hex } from "viem";

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * v4 PoolId = keccak256(abi.encode(PoolKey)). The struct is all value types, so encodeAbiParameters over
 * the five fields in order is byte-identical to Solidity's abi.encode(key). Server- and client-safe
 * (no "use client"); verified against the live pool id in tests.
 */
export function poolIdOf(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}
