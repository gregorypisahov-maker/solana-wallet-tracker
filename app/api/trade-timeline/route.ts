import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Row = Record<string, any>;

const timeOf = (row: Row | null | undefined, ...keys: string[]) => {
  for (const key of keys) if (row?.[key]) return row[key] as string;
  return null;
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });

  const [state, signals, positions, orders, paperOpen, paperClosed] = await Promise.all([
    supabase.from("live_executor_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("live_trade_signals").select("*").order("created_at", { ascending: false }).limit(250),
    supabase.from("live_positions").select("*").order("opened_at", { ascending: false }).limit(150),
    supabase.from("live_orders").select("*").order("created_at", { ascending: false }).limit(300),
    supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: false }).limit(100),
    supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: false }).limit(200),
  ]);

  const errors = [state, signals, positions, orders, paperOpen, paperClosed]
    .map((result: any) => result.error?.message)
    .filter(Boolean);
  if (errors.length) return NextResponse.json({ error: errors.join(" | ") }, { status: 500 });

  const signalRows = (signals.data ?? []) as Row[];
  const positionRows = (positions.data ?? []) as Row[];
  const orderRows = (orders.data ?? []) as Row[];
  const paperRows = [...((paperOpen.data ?? []) as Row[]), ...((paperClosed.data ?? []) as Row[])];

  const ids = new Set<string>();
  for (const row of [...signalRows, ...positionRows, ...paperRows]) {
    if (row.source_position_id) ids.add(String(row.source_position_id));
    if (row.position_id) ids.add(String(row.position_id));
  }

  const trades = [...ids].map((sourcePositionId) => {
    const relatedSignals = signalRows.filter((row) => row.source_position_id === sourcePositionId);
    const buySignal = relatedSignals.find((row) => row.side === "buy") ?? null;
    const sellSignal = relatedSignals.find((row) => row.side === "sell") ?? null;
    const livePosition = positionRows.find((row) => row.source_position_id === sourcePositionId) ?? null;
    const paper = paperRows.find((row) => row.position_id === sourcePositionId) ?? null;
    const relatedOrders = orderRows.filter((row) =>
      row.signal_id === buySignal?.id || row.signal_id === sellSignal?.id ||
      row.id === livePosition?.entry_order_id || row.id === livePosition?.exit_order_id
    );
    const buyOrder = relatedOrders.find((row) => row.side === "buy") ?? null;
    const sellOrder = relatedOrders.find((row) => row.side === "sell") ?? null;

    const createdAt = timeOf(buySignal, "created_at") ?? timeOf(paper, "opened_at", "closed_at") ?? timeOf(livePosition, "opened_at");
    const safety = buySignal?.metadata?.live_safety ?? null;
    const paperPnl = paper?.pnl_sol == null ? null : Number(paper.pnl_sol);
    const livePnl = livePosition?.realized_pnl_sol == null ? null : Number(livePosition.realized_pnl_sol);

    return {
      sourcePositionId,
      tokenSymbol: buySignal?.token_symbol ?? livePosition?.token_symbol ?? paper?.token_symbol ?? "UNKNOWN",
      mint: buySignal?.mint ?? livePosition?.mint ?? paper?.mint ?? null,
      createdAt,
      paper: {
        status: paper?.closed_at ? "closed" : paper ? "open" : "not_found",
        openedAt: timeOf(paper, "opened_at"),
        closedAt: timeOf(paper, "closed_at"),
        sizeSol: paper?.size_sol == null ? null : Number(paper.size_sol),
        pnlSol: paperPnl,
        exitReason: paper?.exit_reason ?? null,
      },
      live: {
        signalStatus: buySignal?.status ?? "not_created",
        rejectionReason: buySignal?.rejection_reason ?? null,
        requestedSizeSol: buySignal?.requested_size_sol == null ? null : Number(buySignal.requested_size_sol),
        safety,
        positionStatus: livePosition?.status ?? "not_opened",
        spentSol: livePosition?.spent_sol == null ? null : Number(livePosition.spent_sol),
        proceedsSol: livePosition?.proceeds_sol == null ? null : Number(livePosition.proceeds_sol),
        pnlSol: livePnl,
        buyTx: buyOrder?.tx_signature ?? livePosition?.entry_tx_signature ?? null,
        sellTx: sellOrder?.tx_signature ?? livePosition?.exit_tx_signature ?? null,
        buyOrderStatus: buyOrder?.status ?? null,
        sellOrderStatus: sellOrder?.status ?? null,
        exitSignalStatus: sellSignal?.status ?? null,
        exitRejectionReason: sellSignal?.rejection_reason ?? null,
      },
      differenceSol: paperPnl != null && livePnl != null ? livePnl - paperPnl : null,
    };
  }).sort((a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0")).slice(0, 75);

  return NextResponse.json({ generatedAt: new Date().toISOString(), executor: state.data ?? null, trades });
}
