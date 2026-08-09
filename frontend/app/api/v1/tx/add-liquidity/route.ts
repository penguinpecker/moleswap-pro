import { NextRequest } from "next/server";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { CONTRACTS, RH_CHAIN_ID } from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This deployment has no user-facing v3 NonfungiblePositionManager — liquidity is provided single-sided
// through the MoleSwap ALM vault (MolePositions.zapOpen), which builds the bounded range itself. The
// previous handler encoded `mint` against an empty ABI and 500'd on every request. Rather than fake a
// two-sided v3 mint that cannot execute, this returns an honest, actionable pointer to the real path.

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  return apiError(
    "Two-sided v3 mint is not available on Robinhood Chain — no position manager is deployed. " +
      `Liquidity is provided single-sided through the MoleSwap ALM vault (MolePositions ${CONTRACTS.MOLE_POSITIONS}, chain ${RH_CHAIN_ID}) ` +
      "via zapOpen(ZapParams,uint256): deposit one of WETH/USDG and the vault swaps half and mints a " +
      "bounded range for you. Use the /vault UI, or call zapOpen directly.",
    501
  );
}
