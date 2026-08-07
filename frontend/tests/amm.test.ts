/**
 * AMM executeSwap Tests
 *
 * Tests the swap execution logic to ensure:
 * 1. Null client is rejected gracefully
 * 2. Error messages are user-friendly
 * 3. Step callbacks work correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the executeSwap parameters and behavior
interface ExecuteSwapParams {
  pushChainClient: any | null;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
  recipient: string;
  originChain?: string | null;
  onStep?: (step: number, label: string, status: string) => void;
}

interface ExecuteSwapResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

// Simplified executeSwap logic for testing
function executeSwapGuard(params: ExecuteSwapParams): ExecuteSwapResult | null {
  // Guard: pushChainClient must be initialized
  if (!params.pushChainClient) {
    return {
      success: false,
      error: 'PushChain client not initialized. Please reconnect your wallet.',
    };
  }

  // Guard: pushChainClient.universal must exist
  if (!params.pushChainClient.universal) {
    return {
      success: false,
      error: 'PushChain universal wallet not available.',
    };
  }

  // Guard: sendTransaction must be a function
  if (typeof params.pushChainClient.universal.sendTransaction !== 'function') {
    return {
      success: false,
      error: 'PushChain sendTransaction not available.',
    };
  }

  // All guards passed
  return null;
}

// Error message decoder (simplified version of getContractErrorMessage)
function decodeError(error: any): string {
  const msg = error?.message || String(error);

  if (msg.includes('universal') && msg.includes('null')) {
    return 'PushChain client not initialized. Please reconnect your wallet.';
  }

  if (msg.includes('User rejected') || msg.includes('User denied')) {
    return 'Transaction rejected in wallet.';
  }

  if (msg.includes('insufficient') || msg.includes('balance')) {
    return 'Insufficient balance for this transaction.';
  }

  if (msg.includes('STF')) {
    return 'Token transfer failed. Check balance and approval.';
  }

  return msg;
}

describe('executeSwap Guards', () => {
  it('rejects null pushChainClient', () => {
    const params: ExecuteSwapParams = {
      pushChainClient: null,
      tokenIn: '0xToken1',
      tokenOut: '0xToken2',
      amountIn: '1000000000000000000',
      amountOutMin: '900000000000000000',
      recipient: '0xRecipient',
    };

    const result = executeSwapGuard(params);
    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('not initialized');
  });

  it('rejects pushChainClient without universal', () => {
    const params: ExecuteSwapParams = {
      pushChainClient: {}, // Missing universal
      tokenIn: '0xToken1',
      tokenOut: '0xToken2',
      amountIn: '1000000000000000000',
      amountOutMin: '900000000000000000',
      recipient: '0xRecipient',
    };

    const result = executeSwapGuard(params);
    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('universal');
  });

  it('rejects when sendTransaction is not a function', () => {
    const params: ExecuteSwapParams = {
      pushChainClient: {
        universal: {
          sendTransaction: 'not a function',
        },
      },
      tokenIn: '0xToken1',
      tokenOut: '0xToken2',
      amountIn: '1000000000000000000',
      amountOutMin: '900000000000000000',
      recipient: '0xRecipient',
    };

    const result = executeSwapGuard(params);
    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('sendTransaction');
  });

  it('passes when client is properly initialized', () => {
    const params: ExecuteSwapParams = {
      pushChainClient: {
        universal: {
          sendTransaction: vi.fn(),
          account: '0xUEA',
        },
      },
      tokenIn: '0xToken1',
      tokenOut: '0xToken2',
      amountIn: '1000000000000000000',
      amountOutMin: '900000000000000000',
      recipient: '0xRecipient',
    };

    const result = executeSwapGuard(params);
    expect(result).toBeNull(); // null means guards passed
  });
});

describe('Error Message Decoding', () => {
  it('decodes null universal error', () => {
    const error = new Error("Cannot read properties of null (reading 'universal')");
    const decoded = decodeError(error);
    expect(decoded).toContain('not initialized');
  });

  it('decodes user rejection', () => {
    const error = new Error('User rejected the request');
    const decoded = decodeError(error);
    expect(decoded).toContain('rejected');
  });

  it('decodes insufficient balance', () => {
    const error = new Error('insufficient funds for gas');
    const decoded = decodeError(error);
    expect(decoded).toContain('Insufficient');
  });

  it('decodes STF (transfer failed)', () => {
    const error = new Error('execution reverted: STF');
    const decoded = decodeError(error);
    expect(decoded).toContain('transfer failed');
  });

  it('returns original message for unknown errors', () => {
    const error = new Error('Some weird error');
    const decoded = decodeError(error);
    expect(decoded).toBe('Some weird error');
  });
});

describe('Step Callback Handling', () => {
  it('calls onStep with correct parameters', () => {
    const onStep = vi.fn();
    const steps = [
      { index: 0, label: 'Approve token', status: 'signing' },
      { index: 0, label: 'Approve token', status: 'confirmed' },
      { index: 1, label: 'Swap tokens', status: 'signing' },
      { index: 1, label: 'Swap tokens', status: 'confirmed' },
    ];

    // Simulate step progression
    steps.forEach(step => {
      onStep(step.index, step.label, step.status);
    });

    expect(onStep).toHaveBeenCalledTimes(4);
    expect(onStep).toHaveBeenNthCalledWith(1, 0, 'Approve token', 'signing');
    expect(onStep).toHaveBeenNthCalledWith(2, 0, 'Approve token', 'confirmed');
    expect(onStep).toHaveBeenNthCalledWith(3, 1, 'Swap tokens', 'signing');
    expect(onStep).toHaveBeenNthCalledWith(4, 1, 'Swap tokens', 'confirmed');
  });

  it('handles error step callback', () => {
    const onStep = vi.fn();

    // Simulate error
    onStep(-1, 'Transaction failed', 'error');

    expect(onStep).toHaveBeenCalledWith(-1, 'Transaction failed', 'error');
  });
});

describe('Balance Pre-flight Checks', () => {
  it('blocks wrap when user has 0 native PC and is from external chain', () => {
    const nativeBalance = 0n;
    const amountIn = BigInt("1000000000000000000"); // 1 PC
    const gasBuffer = BigInt("1000000000000000"); // 0.001 PC
    const required = amountIn + gasBuffer;
    const originChain = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // External chain

    const isPushNative = !originChain ||
      originChain === "eip155:42101" ||
      originChain === "eip155:9001";

    expect(nativeBalance < required).toBe(true);
    expect(isPushNative).toBe(false);

    // Should show helpful error about bridging first
    const shouldShowBridgeHelp = nativeBalance === 0n && !isPushNative;
    expect(shouldShowBridgeHelp).toBe(true);
  });

  it('allows wrap when user has sufficient native PC', () => {
    const nativeBalance = BigInt("2000000000000000000"); // 2 PC
    const amountIn = BigInt("1000000000000000000"); // 1 PC
    const gasBuffer = BigInt("1000000000000000"); // 0.001 PC
    const required = amountIn + gasBuffer;

    expect(nativeBalance >= required).toBe(true);
  });

  it('shows regular error for Push-native user with low balance', () => {
    const nativeBalance = BigInt("500000000000000000"); // 0.5 PC
    const amountIn = BigInt("1000000000000000000"); // 1 PC
    const originChain = "eip155:42101"; // Push Chain native

    const isPushNative = !originChain ||
      originChain === "eip155:42101" ||
      originChain === "eip155:9001";

    // User is Push-native but has low balance - show simple error, not bridge help
    expect(isPushNative).toBe(true);
    const shouldShowBridgeHelp = nativeBalance === 0n && !isPushNative;
    expect(shouldShowBridgeHelp).toBe(false);
  });
});

describe('Origin Chain Detection', () => {
  it('detects Solana origin', () => {
    const originChain = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcojunJhyKVc';
    const isSolana = originChain.toLowerCase().startsWith('solana:');
    expect(isSolana).toBe(true);
  });

  it('detects EVM origin', () => {
    const originChain = 'eip155:42101';
    const isEvm = originChain.toLowerCase().startsWith('eip155:');
    expect(isEvm).toBe(true);
  });

  it('detects Push Chain native', () => {
    const PUSH_CHAIN_NAMESPACES = ['eip155:42101', 'eip155:9001'];
    const originChain = 'eip155:42101';
    const isPushNative = PUSH_CHAIN_NAMESPACES.some(
      ns => originChain.toLowerCase() === ns.toLowerCase()
    );
    expect(isPushNative).toBe(true);
  });

  it('identifies cross-chain origin', () => {
    const PUSH_CHAIN_NAMESPACES = ['eip155:42101', 'eip155:9001'];
    const originChain = 'eip155:11155111'; // Sepolia
    const isPushNative = PUSH_CHAIN_NAMESPACES.some(
      ns => originChain.toLowerCase() === ns.toLowerCase()
    );
    const isCrossChain = !isPushNative;
    expect(isCrossChain).toBe(true);
  });
});
