/**
 * Bridge map — neutralized for the single-chain (Robinhood Chain) deployment.
 *
 * The original file mapped PRC-20s to their cross-chain origins for Push's Universal Gateway. There is
 * no bridging on a single chain, so every lookup reports "not bridgeable". Kept only so existing import
 * sites compile unchanged.
 */
export interface Prc20BridgeInfo {
  prc20Address: string;
  originChain: string;
  originSymbol: string;
  bridgeable: boolean;
}

export function getBridgeInfoForPrc20(_address: string): Prc20BridgeInfo | null {
  return null;
}

export function canAutoBridgeFrom(_token: string, _originChain: string | null | undefined): boolean {
  return false;
}

export function getSdkMoveableToken(_symbol: string): string | null {
  return null;
}
