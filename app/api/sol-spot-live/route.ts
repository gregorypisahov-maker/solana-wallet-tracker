import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { LIVE_ARM_HOURS, finite, isValidSolanaAddress } from "@/lib/solSpotLive";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const noStore = { headers: { "Cache-Control": "no-store, max-age=0" } };

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");

  const supabase = getSupabaseAdmin({ noStore: true });
  const [settingsResult, livePositionResult, paperPositionResult, tradesResult, ordersResult] =
    await Promise.all([
      supabase.from("sol_spot_live_settings").select("*").eq("id", 1).single(),
      supabase.from("sol_spot_live_positions").select("*").eq("id", 1).maybeSingle(),
      supabase.from("sol_spot_paper_positions").select("*").maybeSingle(),
      supabase
        .from("sol_spot_live_trades")
        .select("*")
        .order("closed_at", { ascending: false })
        .limit(20),
      supabase
        .from("sol_spot_live_orders")
        .select("order_id,side,status,signature,error,created_at,executed_at,price_impact_pct")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  const failed = [settingsResult, livePositionResult, paperPositionResult, tradesResult, ordersResult]
    .find((result) => result.error);
  if (failed?.error) {
    console.error("[sol-spot-live] state query failed", failed.error);
    return NextResponse.json({ error: "Live wallet state is temporarily unavailable" }, { status: 500 });
  }

  const settings = settingsResult.data;
  const livePosition = livePositionResult.data ?? null;
  const paperPosition = paperPositionResult.data ?? null;
  const armedUntilMs = settings.armed_until ? Date.parse(settings.armed_until) : 0;
  const armed = settings.armed === true && armedUntilMs > Date.now();

  if (settings.armed && !armed) {
    void supabase
      .from("sol_spot_live_settings")
      .update({ armed: false, armed_until: null, updated_at: new Date().toISOString() })
      .eq("id", 1);
  }

  const nextAction = livePosition
    ? paperPosition
      ? "hold"
      : "sell"
    : paperPosition
      ? "buy"
      : "none";

  const trades = tradesResult.data ?? [];
  const realizedPnlUsdt = trades.reduce(
    (sum: number, trade: any) => sum + finite(trade.pnl_usdt),
    0
  );

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      settings: { ...settings, armed },
      livePosition,
      paperPosition,
      nextAction,
      trades,
      orders: ordersResult.data ?? [],
      realizedPnlUsdt,
      execution: {
        custody: "wallet_signs_every_transaction",
        mode: "manual_approval",
        venue: "jupiter_on_solana",
        apiAccess: process.env.JUPITER_API_KEY?.trim() ? "api_key" : "keyless",
      },
    },
    noStore
  );
}

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const supabase = getSupabaseAdmin({ noStore: true });
  const now = new Date();

  const [{ data: settings, error: settingsError }, { data: livePosition, error: positionError }] =
    await Promise.all([
      supabase.from("sol_spot_live_settings").select("*").eq("id", 1).single(),
      supabase.from("sol_spot_live_positions").select("*").eq("id", 1).maybeSingle(),
    ]);
  if (settingsError || positionError) {
    return NextResponse.json(
      { error: settingsError?.message ?? positionError?.message ?? "Could not load live settings" },
      { status: 500 }
    );
  }

  let patch: Record<string, unknown>;
  if (action === "link_wallet") {
    const walletPublicKey = String(body.walletPublicKey ?? "").trim();
    if (!isValidSolanaAddress(walletPublicKey)) {
      return NextResponse.json({ error: "Invalid Solana wallet address" }, { status: 400 });
    }
    if (livePosition && livePosition.wallet_public_key !== walletPublicKey) {
      return NextResponse.json(
        { error: "Close the tracked live position before linking a different wallet" },
        { status: 409 }
      );
    }
    patch = {
      wallet_public_key: walletPublicKey,
      armed: false,
      armed_until: null,
      updated_at: now.toISOString(),
    };
  } else if (action === "arm") {
    const walletPublicKey = String(body.walletPublicKey ?? "").trim();
    if (!settings.wallet_public_key || walletPublicKey !== settings.wallet_public_key) {
      return NextResponse.json(
        { error: "Connect the linked wallet before arming real execution" },
        { status: 409 }
      );
    }
    patch = {
      armed: true,
      armed_until: new Date(now.getTime() + LIVE_ARM_HOURS * 60 * 60 * 1000).toISOString(),
      updated_at: now.toISOString(),
    };
  } else if (action === "disarm") {
    patch = { armed: false, armed_until: null, updated_at: now.toISOString() };
  } else if (action === "set_size") {
    const maxPositionUsdt = finite(body.maxPositionUsdt);
    if (maxPositionUsdt < 10 || maxPositionUsdt > 200) {
      return NextResponse.json(
        { error: "Real position size must be between 10 and 200 USDT" },
        { status: 400 }
      );
    }
    patch = {
      max_position_usdt: Number(maxPositionUsdt.toFixed(2)),
      armed: false,
      armed_until: null,
      updated_at: now.toISOString(),
    };
  } else {
    return NextResponse.json({ error: "Unknown live-wallet action" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("sol_spot_live_settings")
    .update(patch)
    .eq("id", 1)
    .select("*")
    .single();
  if (error) {
    console.error(`[sol-spot-live] ${action} failed`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, settings: data }, noStore);
}
