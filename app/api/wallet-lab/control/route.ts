import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Action = "promote" | "disable";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
  const action = body.action as Action;
  if (!walletAddress || !["promote", "disable"].includes(action)) {
    return NextResponse.json({ error: "Invalid Wallet Lab control request" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: candidate, error: candidateError } = await supabase
    .from("wallet_lab_candidates")
    .select("wallet_address,status,lab_trust_score,final_profile")
    .eq("wallet_address", walletAddress)
    .maybeSingle();
  if (candidateError) {
    return NextResponse.json({ error: candidateError.message }, { status: 500 });
  }
  if (!candidate) {
    return NextResponse.json({ error: "Wallet Lab candidate not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  if (action === "promote") {
    if (candidate.status !== "qualified") {
      return NextResponse.json(
        { error: `Only qualified wallets can enter trial; current status is ${candidate.status}` },
        { status: 409 }
      );
    }
    const { count, error: countError } = await supabase
      .from("wallet_lab_candidates")
      .select("wallet_address", { count: "exact", head: true })
      .eq("status", "trial");
    if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
    if ((count ?? 0) >= 2) {
      return NextResponse.json(
        { error: "Wallet Lab trial pool is full (maximum two wallets)" },
        { status: 409 }
      );
    }

    const { data, error } = await supabase
      .from("wallet_lab_candidates")
      .update({
        status: "trial",
        promoted_at: now,
        last_signature: null,
        rejection_reasons: [],
        updated_at: now,
      })
      .eq("wallet_address", walletAddress)
      .eq("status", "qualified")
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(
      { ok: true, action, candidate: data, message: "Wallet added to isolated Lab Bot trial" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const { data, error } = await supabase
    .from("wallet_lab_candidates")
    .update({
      status: "disabled",
      last_signature: null,
      rejection_reasons: ["owner_disabled"],
      updated_at: now,
    })
    .eq("wallet_address", walletAddress)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { ok: true, action, candidate: data, message: "Wallet removed from Wallet Lab trial" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
