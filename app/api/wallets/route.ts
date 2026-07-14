import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, unauthorized } from "@/lib/dashboardAuth";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";
const MAX_WALLETS = 20;

function validAddress(address: string): boolean {
  try { new PublicKey(address); return true; } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const [{ data, error }, { data: performance, error: performanceError }] = await Promise.all([
    supabase.from("wallets").select("address, label, active, created_at").order("created_at", { ascending: true }),
    supabase.from("wallet_performance").select("wallet_address,trust_score,completed_trades,win_rate,average_return"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (performanceError) return NextResponse.json({ error: performanceError.message }, { status: 500 });
  const performanceByAddress = new Map((performance ?? []).map((row) => [row.wallet_address, row]));
  return NextResponse.json({ wallets: (data ?? []).map((wallet) => ({ ...wallet, performance: performanceByAddress.get(wallet.address) ?? null })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const body = await req.json();
  const addresses: { address: string; label?: string }[] = body.addresses
    ? body.addresses.map((a: string) => ({ address: a.trim() }))
    : [{ address: String(body.address ?? "").trim(), label: String(body.label ?? "").trim().slice(0, 80) || undefined }];
  const cleaned = Array.from(new Map(addresses.filter((a) => a.address.length > 0).map((a) => [a.address, a])).values());
  if (!cleaned.length) return NextResponse.json({ error: "No addresses provided" }, { status: 400 });
  const invalid = cleaned.find((item) => !validAddress(item.address));
  if (invalid) return NextResponse.json({ error: `Invalid Solana wallet address: ${invalid.address}` }, { status: 400 });

  const [{ count: activeCount }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from("wallets").select("*", { count: "exact", head: true }).eq("active", true),
    supabase.from("wallets").select("address,active").in("address", cleaned.map((item) => item.address)),
  ]);
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  const activeByAddress = new Map((existing ?? []).map((row) => [row.address, row.active]));
  const newlyActive = cleaned.filter((item) => activeByAddress.get(item.address) !== true).length;
  if ((activeCount ?? 0) + newlyActive > MAX_WALLETS) return NextResponse.json({ error: `This would exceed the ${MAX_WALLETS} active-wallet limit (currently active: ${activeCount ?? 0}).` }, { status: 400 });

  const { error } = await supabase.from("wallets").upsert(cleaned.map((item) => ({ ...item, active: true })), { onConflict: "address" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const body = await req.json();
  const address = String(body.address ?? "").trim();
  if (!validAddress(address)) return NextResponse.json({ error: "Valid wallet address required" }, { status: 400 });

  const updates: { active?: boolean; label?: string | null } = {};
  if (typeof body.active === "boolean") updates.active = body.active;
  if (Object.prototype.hasOwnProperty.call(body, "label")) updates.label = String(body.label ?? "").trim().slice(0, 80) || null;
  if (!Object.keys(updates).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  if (updates.active === true) {
    const { count } = await supabase.from("wallets").select("*", { count: "exact", head: true }).eq("active", true);
    const { data: current } = await supabase.from("wallets").select("active").eq("address", address).maybeSingle();
    if (!current?.active && (count ?? 0) >= MAX_WALLETS) return NextResponse.json({ error: `The ${MAX_WALLETS} active-wallet limit has been reached.` }, { status: 400 });
  }

  const { data, error } = await supabase.from("wallets").update(updates).eq("address", address).select("address").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Wallet not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Admin authentication required");
  const supabase = getSupabaseAdmin();
  const address = String((await req.json()).address ?? "").trim();
  if (!validAddress(address)) return NextResponse.json({ error: "Valid wallet address required" }, { status: 400 });
  const { data, error } = await supabase.from("wallets").delete().eq("address", address).select("address").maybeSingle();
  if (error) return NextResponse.json({ error: `Could not remove wallet: ${error.message}` }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Wallet not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
