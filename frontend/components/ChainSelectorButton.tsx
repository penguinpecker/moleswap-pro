"use client";
import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import { usePushWallet } from "@/lib/pushchain/provider";

declare global {
  interface Window {
    ethereum?: any;
  }
}

interface ChainInfo {
  id: string;
  name: string;
  short: string;
  logo: string;
  hexId?: string;
  rpcUrl?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

const SUPPORTED_CHAINS: ChainInfo[] = [
  {
    id: "eip155:1",
    name: "Ethereum",
    short: "ETH",
    logo: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
    hexId: "0x1",
  },
  {
    id: "solana",
    name: "Solana",
    short: "SOL",
    logo: "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  },
  {
    id: "eip155:8453",
    name: "Base",
    short: "BASE",
    logo: "https://raw.githubusercontent.com/base-org/brand-kit/001c0e9b40a67799ebe0418671ac4e02a0c683ce/logo/symbol/Base_Symbol_Blue.png",
    hexId: "0x2105",
    rpcUrl: "https://mainnet.base.org",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  {
    id: "eip155:42161",
    name: "Arbitrum",
    short: "ARB",
    logo: "https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg",
    hexId: "0xa4b1",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  {
    id: "eip155:56",
    name: "BNB Chain",
    short: "BNB",
    logo: "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
    hexId: "0x38",
    rpcUrl: "https://bsc-dataseed.binance.org",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  },
  {
    id: "eip155:42101",
    name: "PushChain",
    short: "PC",
    logo: "/push-chain-logo.png",
    hexId: "0xa455",
  },
];

function getChainInfo(originChain: string | null): ChainInfo {
  if (!originChain) return SUPPORTED_CHAINS[SUPPORTED_CHAINS.length - 1];
  if (originChain.startsWith("solana:")) {
    return SUPPORTED_CHAINS.find((c) => c.id === "solana")!;
  }
  return (
    SUPPORTED_CHAINS.find((c) => c.id === originChain) ??
    SUPPORTED_CHAINS[SUPPORTED_CHAINS.length - 1]
  );
}

async function switchEthereumChain(chain: ChainInfo): Promise<boolean> {
  if (!chain.hexId || typeof window === "undefined" || !window.ethereum)
    return false;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.hexId }],
    });
    return true;
  } catch (err: any) {
    if (err.code === 4902 && chain.rpcUrl) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chain.hexId,
              chainName: chain.name,
              rpcUrls: [chain.rpcUrl],
              nativeCurrency: chain.nativeCurrency,
            },
          ],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function ChainSelectorButton() {
  const { originChain, isConnected } = usePushWallet();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentChain = getChainInfo(originChain);
  const isSolanaWallet = originChain?.startsWith("solana:");

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSwitchError(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!isConnected) return null;

  const handleChainSelect = async (chain: ChainInfo) => {
    if (chain.id === currentChain.id) {
      setOpen(false);
      return;
    }
    if (chain.id === "solana" || !chain.hexId) {
      setSwitchError("Connect a Solana wallet (e.g. Phantom) to use this network.");
      return;
    }
    if (isSolanaWallet) {
      setSwitchError("Disconnect Solana wallet first, then connect an EVM wallet.");
      return;
    }
    setSwitching(chain.id);
    setSwitchError(null);
    const ok = await switchEthereumChain(chain);
    setSwitching(null);
    if (ok) {
      window.dispatchEvent(
        new CustomEvent("chainChanged", { detail: { chainId: chain.id } })
      );
      setOpen(false);
    } else {
      setSwitchError(`Could not switch to ${chain.name}. Try in your wallet app.`);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => {
          setOpen(!open);
          setSwitchError(null);
        }}
        className="font-family-ThaleahFat flex cursor-pointer items-center gap-1.5 px-3 py-3 text-lg tracking-wider text-black transition-all hover:scale-[1.02] sm:text-xl"
        title={`Connected via ${currentChain.name}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentChain.logo}
          alt={currentChain.name}
          width={20}
          height={20}
          className="h-5 w-5 rounded-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <span className="hidden sm:inline">{currentChain.short}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="bg-ground absolute left-0 top-full z-[200] mt-2 w-52 rounded-lg border-3 border-[#523525] shadow-[4px_4px_0_#000] animate-pop-up">
          <div className="border-b-2 border-[#523525] px-4 py-2">
            <span className="font-family-ThaleahFat text-peach-300/60 text-xs tracking-widest">
              NETWORK
            </span>
          </div>

          {SUPPORTED_CHAINS.map((chain) => {
            const isCurrent = chain.id === currentChain.id;
            const isLoading = switching === chain.id;
            return (
              <button
                key={chain.id}
                onClick={() => handleChainSelect(chain)}
                disabled={!!switching}
                className={`font-family-ThaleahFat flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-base tracking-wider transition-all hover:bg-[#523525] disabled:opacity-60 first:rounded-none last:rounded-b-lg ${
                  isCurrent ? "text-yellow-300" : "text-peach-300"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={chain.logo}
                  alt={chain.name}
                  width={18}
                  height={18}
                  className="h-[18px] w-[18px] shrink-0 rounded-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
                <span className="flex-1 text-left">{chain.name}</span>
                {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-yellow-300" />}
                {isLoading && (
                  <span className="text-peach-300/60 text-xs">...</span>
                )}
              </button>
            );
          })}

          {switchError && (
            <div className="flex items-start gap-2 border-t-2 border-[#523525] px-4 py-2.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              <span className="font-family-ThaleahFat text-xs leading-tight tracking-wide text-red-400">
                {switchError}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
