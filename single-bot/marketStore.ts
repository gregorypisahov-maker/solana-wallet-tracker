import { createClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

type MemoryDatabase = {
  state: Row;
  trades: Row[];
  nextTradeId: number;
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

const memory: MemoryDatabase = {
  state: {
    id: "main",
    enabled: true,
    mode: "paper",
    cash_usdc: 10,
    starting_cash_usdc: 10,
    realized_pnl_usdc: 0,
    daily_date: todayUtc(),
    daily_realized_pnl_usdc: 0,
    entries_today: 0,
    halted: false,
    halt_reason: null,
    last_scan_at: null,
    last_heartbeat_at: null,
    last_error: null,
    open_position: null,
    scanner_snapshot: {},
    updated_at: new Date().toISOString(),
  },
  trades: [],
  nextTradeId: 1,
};

class MemoryQuery {
  private operation: "select" | "insert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Array<[string, unknown]> = [];
  private selected = "*";
  private orderBy: { column: string; ascending: boolean } | null = null;
  private maxRows: number | null = null;

  constructor(private readonly table: string) {}

  select(columns = "*"): this {
    this.selected = columns;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  async single(): Promise<{ data: Row | null; error: Error | null }> {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    if (rows.length === 0) return { data: null, error: new Error("memory_store_row_not_found") };
    return { data: rows[0], error: null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: Error | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private project(row: Row): Row {
    if (this.selected === "*" || !this.selected) return { ...row };
    const columns = this.selected.split(",").map((value) => value.trim()).filter(Boolean);
    return Object.fromEntries(columns.map((column) => [column, row[column]]));
  }

  private rows(): Row[] {
    if (this.table === "single_market_bot_state") return [memory.state];
    if (this.table === "single_market_bot_trades") return memory.trades;
    return [];
  }

  private async execute(): Promise<{ data: any; error: Error | null }> {
    try {
      if (this.operation === "insert") {
        const values = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
        const inserted = values.map((value) => {
          const now = new Date().toISOString();
          const row = {
            id: memory.nextTradeId++,
            created_at: now,
            updated_at: now,
            metadata: {},
            ...value,
          };
          if (this.table === "single_market_bot_trades") memory.trades.push(row);
          return this.project(row);
        });
        return { data: inserted, error: null };
      }

      let rows = this.rows().filter((row) => this.matches(row));

      if (this.operation === "update") {
        for (const row of rows) Object.assign(row, this.payload ?? {});
      }

      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[column] ?? "";
          const bv = b[column] ?? "";
          return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (this.maxRows != null) rows = rows.slice(0, this.maxRows);
      return { data: rows.map((row) => this.project(row)), error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

class MemoryStore {
  from(table: string): MemoryQuery {
    return new MemoryQuery(table);
  }
}

export function getMarketStore(): any {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key) {
    console.log("[single-market-bot] persistence=supabase");
    return createClient(url, key, { auth: { persistSession: false } });
  }
  console.warn("[single-market-bot] persistence=memory (Supabase variables are not configured)");
  return new MemoryStore();
}
