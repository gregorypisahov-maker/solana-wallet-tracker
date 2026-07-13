import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, unauthorized } from "@/lib/dashboardAuth";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

const MAX_WALLETS = 20;

function validAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const [{ data, error }, { data: performance, error: performanceError }] = await Promise.all([
    supabase
      .from("wallets")
      .select("address, label, active, created_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("wallet_performance")
      .select("wallet_address,trust_score,completed_trades,win_rate,average_return"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (performanceError) return NextResponse.json({ error: performanceError.message }, { status: 500 });

  const performanceByAddress = new Map(
    (performance ?? []).map((row) => [row.wallet_address, row])
  );
  return NextResponse.json({
    wallets: (data ?? []).map((wallet) => ({
      ...wallet,
      performance: performanceByAddress.get(wallet.address) ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const body = await req.json();

  const addresses: { address: string; label?: string }[] = body.addresses
    ? body.addresses.map((a: string) => ({ address: a.trim() }))
    : [{
        address: String(body.address ?? "").trim(),
        label: String(body.label ?? "").trim().slice(0, 80) || undefined,
      }];

  const cleaned = Array.from(
    new Map(
      addresses
        .filter((a) => a.address.length > 0)
        .map((a) => [a.address, a])
    ).values()
  );
  if (!cleaned.length) {
    return NextResponse.json({ error: "No addresses provided" }, { status: 400 });
  }
  const invalid = cleaned.find((item) => !validAddress(item.address));
  if (invalid) {
    return NextResponse.json(
      { error: `Invalid Solana wallet address: ${invalid.address}` },
      { status: 400 }
    );
  }

  const [{ count: activeCount }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from("wallets").select("*", { count: "exact", head: true }).eq("active", true),
    supabase.from("wallets").select("address,active").in("address", cleaned.map((item) => item.address)),
  ]);
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  const activeByAddress = new Map((existing ?? []).map((row) => [row.address, row.active]));
  const newlyActive = cleaned.filter((item) => activeByAddress.get(item.address) !== true).length;
  if ((activeCount ?? 0) + newlyActive > MAX_WALLETS) {
    return NextResponse.json(
      { error: `This would exceed the ${MAX_WALLETS} active-wallet limit (currently active: ${activeCount ?? 0}).` },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("wallets")
    .upsert(cleaned.map((item) => ({ ...item, active: true })), { onConflict: "address" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const body = await req.json();
  const address = String(body.address ?? "").trim();
  const active = body.active;

  if (!validAddress(address) || typeof active !== "boolean") {
    return NextResponse.json({ error: "Valid address and boolean active value required" }, { status: 400 });
  }

  if (active) {
    const { count } = await supabase
      .from("wallets")
      .select("*", { count: "exact", head: true })
      .eq("active", true);
    if ((count ?? 0) >= MAX_WALLETS) {
      return NextResponse.json(
        { error: `The ${MAX_WALLETS} active-wallet limit has been reached.` },
        { status: 400 }
      );
    }
  }

  const { error } = await supabase.from("wallets").update({ active }).eq("address", address);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const { address } = await req.json();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  // "Remove" means deactivate so trade history and learned performance
  // remain available for later analysis or reactivation.
  const { error } = await supabase.from("wallets").update({ active: false }).eq("address", address);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
