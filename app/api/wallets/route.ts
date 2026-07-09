import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_WALLETS = 20;

export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("wallets")
    .select("address, label, active, created_at")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ wallets: data });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const body = await req.json();

  const addresses: { address: string; label?: string }[] = body.addresses
    ? body.addresses.map((a: string) => ({ address: a.trim() }))
    : [{ address: String(body.address ?? "").trim(), label: body.label }];

  const cleaned = addresses.filter((a) => a.address.length > 0);
  if (!cleaned.length) {
    return NextResponse.json({ error: "No addresses provided" }, { status: 400 });
  }

  const { count } = await supabase.from("wallets").select("*", { count: "exact", head: true });
  if ((count ?? 0) + cleaned.length > MAX_WALLETS) {
    return NextResponse.json(
      { error: `This would exceed the ${MAX_WALLETS} wallet limit (currently tracking ${count}).` },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("wallets")
    .upsert(cleaned, { onConflict: "address", ignoreDuplicates: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const { address } = await req.json();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const { error } = await supabase.from("wallets").delete().eq("address", address);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
