"use client";
/**
 * use-swap-settings.ts — React binding for the persisted Swap Settings.
 *
 * Initial render deliberately returns DEFAULT_SWAP_SETTINGS, and the stored value is loaded in an
 * effect. Reading localStorage during render would produce different markup on the server and the
 * client and trip a hydration mismatch; the one extra render is cheaper than that.
 */
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SWAP_SETTINGS,
  readSwapSettings,
  slippageBpsFor,
  subscribeSwapSettings,
  writeSwapSettings,
  type SwapSettings,
} from "@/lib/settings/swapSettings";

export function useSwapSettings(): {
  settings: SwapSettings;
  /** The tolerance these settings resolve to, in bps — the number the on-chain floor is built from. */
  slippageBps: number;
  setSettings: (patch: Partial<SwapSettings>) => void;
} {
  const [settings, setLocal] = useState<SwapSettings>(DEFAULT_SWAP_SETTINGS);

  useEffect(() => {
    setLocal(readSwapSettings());
    return subscribeSwapSettings(setLocal);
  }, []);

  const setSettings = useCallback((patch: Partial<SwapSettings>) => {
    // Write against the freshest stored value, not a captured one, so two panels edited in quick
    // succession cannot clobber each other's field.
    setLocal(writeSwapSettings({ ...readSwapSettings(), ...patch }));
  }, []);

  return { settings, slippageBps: slippageBpsFor(settings.maxSlippage), setSettings };
}

export default useSwapSettings;
