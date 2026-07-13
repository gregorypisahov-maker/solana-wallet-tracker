import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!hasViewerAccess(req)) return unauthorized();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("token_scores")
    .select("*")
    .order("score", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tokens: data });
}
