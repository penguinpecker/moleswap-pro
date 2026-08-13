import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Quest progression, server side.
 *
 * The browser used to call the `progress_quest` RPC directly with the anon key.
 * That function is SECURITY DEFINER and awards XP, and it takes the target user id
 * as a plain argument — so anyone could credit XP to any account. The 2026-08-13
 * audit demonstrated it live.
 *
 * `progress_quest` is now revoked from anon/authenticated. It is reached through
 * `progress_quest_gated(p_secret, ...)`, which checks the shared write secret held
 * in mp_private.indexer_config — the same pattern the mp_* indexer RPCs use. The
 * secret lives only in this server process; the browser never sees it.
 *
 * NOTE (deliberate, and worth stating plainly): this removes ARBITRARY-VALUE and
 * off-site forgery, but it is not wallet-ownership proof. Identity here is still a
 * user id supplied by the caller, so a determined actor can still progress their own
 * quests. Closing that needs a signed-nonce session, which is a separate change.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const WRITE_SECRET =
  process.env.MP_WRITE_SECRET || process.env.KEEPER_SECRET || process.env.INDEXER_SECRET;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_RE = /^[a-z0-9_]{1,40}$/;

export async function POST(req: NextRequest) {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    return NextResponse.json({ error: "supabase not configured" }, { status: 503 });
  }
  if (!WRITE_SECRET) {
    // Fail closed: without the secret we cannot call the gated RPC, and we must not
    // fall back to the ungated one.
    return NextResponse.json({ error: "server not configured" }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const userId = String(body?.userId ?? "");
  const actionType = String(body?.actionType ?? "");
  const actionData =
    body?.actionData && typeof body.actionData === "object" && !Array.isArray(body.actionData)
      ? body.actionData
      : {};

  if (!UUID_RE.test(userId)) {
    return NextResponse.json({ error: "invalid userId" }, { status: 400 });
  }
  if (!ACTION_RE.test(actionType)) {
    return NextResponse.json({ error: "invalid actionType" }, { status: 400 });
  }
  // Bound the free-form blob so it cannot be used as storage.
  if (JSON.stringify(actionData).length > 2000) {
    return NextResponse.json({ error: "actionData too large" }, { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc("progress_quest_gated", {
    p_secret: WRITE_SECRET,
    p_user_id: userId,
    p_action_type: actionType,
    p_action_data: actionData,
  });

  if (error) {
    // Never echo the DB error to the client — it can carry schema detail.
    console.error("progress_quest_gated failed:", error.message);
    return NextResponse.json({ error: "quest progression failed" }, { status: 502 });
  }

  return NextResponse.json({ success: true, progressed: data ?? [] });
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
