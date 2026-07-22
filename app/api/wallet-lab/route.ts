import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

const MAX_ACTIVE_WALLETS = 20;
const PLATFORM_LABELS: Record<string, string> = {
  gmgn: "GMGN",
  birdeye: "Birdeye",
  dexcheck: "DexCheck",
  manual: "Manual",
};

function validAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function normalizedPlatform(value: unknown): string {
  const raw = String(value ?? "manual")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return raw || "manual";
}

function parseAddresses(body: any): string[] {
  const direct = Array.isArray(body?.addresses) ? body.addresses : [];
  const text = typeof body?.text === "string" ? body.text.split(/[\s,;]+/) : [];
  return [...new Set([...direct, ...text].map((value) => String(value).trim()).filter(Boolean))];
}

function platformDisplay(source: string): string {
  const key = source.split("_")[0]?.toLowerCase() ?? source;
  return PLATFORM_LABELS[key] ?? source;
}

export async function GET(req: NextRequest) {
  if (!hasViewerAccess(req) && !hasAdminAccess(req)) return unauthorized("Dashboard access required");
  const supabase = getSupabaseAdmin();

  const [{ data: candidates, error }, { data: wallets, error: walletError }] = await Promise.all([
    supabase
      .from("wallet_lab_candidates")
      .select(
        "wallet_address,source,status,first_seen_at,last_seen_at,observation_count,leaderboard_score,leaderboard_metrics,final_profile,lab_trust_score,profiled_at,qualified_at,rejected_at,rejection_reasons,promoted_at,updated_at,scan_status,scan_requested_at,scan_started_at,scan_completed_at,scan_error,scan_limit"
      )
      .order("lab_trust_score", { ascending: false, nullsFirst: false })
      .order("leaderboard_score", { ascending: false })
      .limit(500),
    supabase.from("wallets").select("address,label,active,management_status,discovery_source"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (walletError) return NextResponse.json({ error: walletError.message }, { status: 500 });

  const liveByAddress = new Map((wallets ?? []).map((wallet) => [wallet.address, wallet]));
  const rows = (candidates ?? []).map((candidate: any) => {
    const live = liveByAddress.get(candidate.wallet_address) as any;
    const profile = candidate.final_profile ?? null;
    return {
      address: candidate.wallet_address,
      source: candidate.source,
      platform: platformDisplay(candidate.source),
      status: candidate.status,
      scanStatus: candidate.scan_status,
      scanRequestedAt: candidate.scan_requested_at,
      scanStartedAt: candidate.scan_started_at,
      scanCompletedAt: candidate.scan_completed_at,
      scanError: candidate.scan_error,
      scanLimit: candidate.scan_limit,
      qualityPercent:
        candidate.lab_trust_score == null ? null : Number(candidate.lab_trust_score),
      qualityLabel: profile?.quality_label ?? null,
      profile,
      observationCount: Number(candidate.observation_count ?? 0),
      leaderboardScore: Number(candidate.leaderboard_score ?? 0),
      profiledAt: candidate.profiled_at,
      rejectionReasons: candidate.rejection_reasons ?? [],
      active: Boolean(live?.active),
      liveStatus: live?.management_status ?? null,
      label: live?.label ?? null,
      firstSeenAt: candidate.first_seen_at,
      updatedAt: candidate.updated_at,
    };
  });

  const ranked = rows
    .filter((row) => row.qualityPercent != null)
    .sort((a, b) => Number(b.qualityPercent) - Number(a.qualityPercent));

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      summary: {
        total: rows.length,
        active: rows.filter((row) => row.active).length,
        queued: rows.filter((row) => row.scanStatus === "queued").length,
        running: rows.filter((row) => row.scanStatus === "running").length,
        completed: rows.filter((row) => row.scanStatus === "complete").length,
        qualified: rows.filter((row) => row.profile?.qualifies_for_trial === true).length,
        profiled: ranked.length,
      },
      top10: ranked.slice(0, 10),
      candidates: rows,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  if (!hasAdminAccess(req)) return unauthorized("Owner authentication required");
  const supabase = getSupabaseAdmin();
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "import").toLowerCase();
  const now = new Date().toISOString();

  if (action === "import") {
    const addresses = parseAddresses(body);
    if (!addresses.length) return NextResponse.json({ error: "No wallet addresses provided" }, { status: 400 });
    const invalid = addresses.find((address) => !validAddress(address));
    if (invalid) return NextResponse.json({ error: `Invalid Solana wallet: ${invalid}` }, { status: 400 });

    const platform = normalizedPlatform(body.platform);
    const source = `${platform}_manual_import`;
    const { data: existing, error: existingError } = await supabase
      .from("wallet_lab_candidates")
      .select("wallet_address,leaderboard_metrics,observation_count,status")
      .in("wallet_address", addresses);
    if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

    const existingByAddress = new Map((existing ?? []).map((row: any) => [row.wallet_address, row]));
    const newRows = addresses
      .filter((address) => !existingByAddress.has(address))
      .map((address, index) => ({
        wallet_address: address,
        source,
        status: "observing",
        first_seen_at: now,
        last_seen_at: now,
        observation_count: 1,
        leaderboard_score: body.priority === false ? 100 : 1_000 - index,
        leaderboard_metrics: {
          discovery_platform: PLATFORM_LABELS[platform] ?? platform,
          added_by_user: true,
          priority_profile: body.priority !== false,
          imported_at: now,
        },
        scan_status: "queued",
        scan_requested_at: now,
        scan_error: null,
        scan_limit: Math.max(20, Math.min(200, Number(body.scanLimit ?? 80) || 80)),
      }));

    if (newRows.length > 0) {
      const { error: insertError } = await supabase.from("wallet_lab_candidates").insert(newRows);
      if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    for (const address of addresses.filter((item) => existingByAddress.has(item))) {
      const current = existingByAddress.get(address) as any;
      const { error: updateError } = await supabase
        .from("wallet_lab_candidates")
        .update({
          source,
          last_seen_at: now,
          observation_count: Number(current.observation_count ?? 0) + 1,
          leaderboard_score: Math.max(100, Number(body.leaderboardScore ?? 1_000)),
          leaderboard_metrics: {
            ...(current.leaderboard_metrics ?? {}),
            discovery_platform: PLATFORM_LABELS[platform] ?? platform,
            added_by_user: true,
            priority_profile: body.priority !== false,
            imported_at: now,
          },
          scan_status: "queued",
          scan_requested_at: now,
          scan_error: null,
          scan_limit: Math.max(20, Math.min(200, Number(body.scanLimit ?? 80) || 80)),
          updated_at: now,
        })
        .eq("wallet_address", address);
      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, imported: addresses.length, queued: addresses.length });
  }

  if (action === "queue_scan") {
    const addresses = parseAddresses(body);
    let query = supabase
      .from("wallet_lab_candidates")
      .update({
        scan_status: "queued",
        scan_requested_at: now,
        scan_started_at: null,
        scan_completed_at: null,
        scan_error: null,
        updated_at: now,
      });
    if (addresses.length > 0) query = query.in("wallet_address", addresses);
    else if (body.platform) query = query.ilike("source", `${normalizedPlatform(body.platform)}%`);
    else query = query.in("status", ["observing", "qualified", "rejected", "trial"]);
    const { data, error } = await query.select("wallet_address");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, queued: data?.length ?? 0 });
  }

  if (action === "activate") {
    const addresses = parseAddresses(body);
    if (!addresses.length) return NextResponse.json({ error: "Wallet address required" }, { status: 400 });
    const invalid = addresses.find((address) => !validAddress(address));
    if (invalid) return NextResponse.json({ error: `Invalid Solana wallet: ${invalid}` }, { status: 400 });

    const [{ count: activeCount }, { data: existingActive, error: activeError }] = await Promise.all([
      supabase.from("wallets").select("address", { count: "exact", head: true }).eq("active", true),
      supabase.from("wallets").select("address,active").in("address", addresses),
    ]);
    if (activeError) return NextResponse.json({ error: activeError.message }, { status: 500 });
    const activeMap = new Map((existingActive ?? []).map((row: any) => [row.address, row.active]));
    const newlyActive = addresses.filter((address) => activeMap.get(address) !== true).length;
    if ((activeCount ?? 0) + newlyActive > MAX_ACTIVE_WALLETS) {
      return NextResponse.json(
        { error: `Activation would exceed the ${MAX_ACTIVE_WALLETS}-wallet safety limit.` },
        { status: 400 }
      );
    }

    const { data: labRows, error: labError } = await supabase
      .from("wallet_lab_candidates")
      .select("wallet_address,source,final_profile,lab_trust_score")
      .in("wallet_address", addresses);
    if (labError) return NextResponse.json({ error: labError.message }, { status: 500 });
    const labByAddress = new Map((labRows ?? []).map((row: any) => [row.wallet_address, row]));

    const walletRows = addresses.map((address, index) => {
      const lab = labByAddress.get(address) as any;
      return {
        address,
        label: String(body.label ?? `Lab Wallet ${index + 1}`).slice(0, 80),
        active: true,
        management_status: "trial",
        discovery_source: lab?.source ?? "wallet_lab_manual",
        discovered_at: now,
        management_updated_at: now,
        auto_disabled_at: null,
        auto_disable_reason: null,
        discovery_metrics: {
          lab_profile: lab?.final_profile ?? null,
          lab_quality_percent: lab?.lab_trust_score == null ? null : Number(lab.lab_trust_score),
          activation_mode: "wallet_lab_manual_trial",
          activated_at: now,
        },
      };
    });
    const { error: walletUpsertError } = await supabase
      .from("wallets")
      .upsert(walletRows, { onConflict: "address" });
    if (walletUpsertError) return NextResponse.json({ error: walletUpsertError.message }, { status: 500 });

    const { error: labUpdateError } = await supabase
      .from("wallet_lab_candidates")
      .update({ status: "trial", promoted_at: now, updated_at: now })
      .in("wallet_address", addresses);
    if (labUpdateError) return NextResponse.json({ error: labUpdateError.message }, { status: 500 });
    return NextResponse.json({ ok: true, activated: addresses.length });
  }

  if (action === "deactivate") {
    const addresses = parseAddresses(body);
    if (!addresses.length) return NextResponse.json({ error: "Wallet address required" }, { status: 400 });
    const { error } = await supabase
      .from("wallets")
      .update({ active: false, management_updated_at: now })
      .in("address", addresses);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deactivated: addresses.length });
  }

  return NextResponse.json({ error: `Unknown Wallet Lab action: ${action}` }, { status: 400 });
}
