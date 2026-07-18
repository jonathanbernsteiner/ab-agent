// A tiny in-memory stand-in for a Supabase (PostgREST) client, implementing
// exactly the query surface src/lib/store.ts and src/lib/pipeline.ts use:
//   from(t).insert(payload).select(cols).single()
//   from(t).upsert(payload, { onConflict })
//   from(t).update(payload).eq(...)
//   from(t).select(cols).eq/.neq/.is(...).order(...).limit(...)  (awaited)
// The point is to run the REAL store logic (import state-survival, dedupe,
// chaser resolution, export) with no Docker/live DB. It is deliberately not a
// general Postgres — only what the code exercises.

type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: "eq" | "neq" | "is";
  val: unknown;
}

export class FakeSupabase {
  private tables = new Map<string, Row[]>();
  private idSeq = 0;
  private seq = 0; // monotonic clock for created_at ordering

  from(table: string): FakeQuery {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new FakeQuery(this, table);
  }

  // Storage is not exercised by the model-independent tests; make uploads fail
  // softly so pipeline.ts's best-effort storeDocument() falls back to null.
  storage = {
    getBucket: async () => ({ data: { name: "test" }, error: null }),
    createBucket: async () => ({ data: null, error: null }),
    from: () => ({
      upload: async () => ({ data: null, error: { message: "no storage in tests" } }),
      createSignedUrl: async () => ({ data: null, error: { message: "no storage in tests" } }),
    }),
  };

  // ── internals used by FakeQuery ──
  _rows(table: string): Row[] {
    let r = this.tables.get(table);
    if (!r) {
      r = [];
      this.tables.set(table, r);
    }
    return r;
  }
  _nextId(): string {
    return `id-${++this.idSeq}`;
  }
  _nextSeq(): number {
    return ++this.seq;
  }

  // Test inspection helpers.
  all(table: string): Row[] {
    return [...this._rows(table)];
  }
  count(table: string): number {
    return this._rows(table).length;
  }
  reset(): void {
    this.tables.clear();
    this.idSeq = 0;
    this.seq = 0;
  }
}

type Op = "select" | "insert" | "upsert" | "update" | "delete";

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: Op = "select";
  private payload: Row | Row[] = {};
  private onConflict: string[] = [];
  private filters: Filter[] = [];
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private rangeFromTo: { from: number; to: number } | null = null;
  private wantSingle = false;
  private returning = false;

  constructor(private db: FakeSupabase, private table: string) {}

  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  select(_cols?: string): this {
    // select() before any write is a read; after a write it's a RETURNING clause.
    if (this.op === "insert" || this.op === "upsert" || this.op === "update") {
      this.returning = true;
    } else {
      this.op = "select";
    }
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ col, op: "neq", val });
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push({ col, op: "is", val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFromTo = { from, to };
    return this;
  }
  single(): this {
    this.wantSingle = true;
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const v = row[f.col];
      if (f.op === "eq") return v === f.val;
      if (f.op === "neq") return v !== f.val;
      // "is": null means null/undefined; otherwise equality (real PostgREST
      // only allows is-null/true/false, but store.ts uses .is for position).
      if (f.val === null) return v === null || v === undefined;
      return v === f.val;
    });
  }

  private run(): { data: unknown; error: unknown } {
    const rows = this.db._rows(this.table);

    if (this.op === "insert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = items.map((p) => this.materialize(p));
      inserted.forEach((r) => rows.push(r));
      if (!this.returning) return { data: null, error: null };
      return { data: this.wantSingle ? inserted[0] ?? null : inserted, error: null };
    }

    if (this.op === "upsert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out: Row[] = [];
      for (const p of items) {
        const existing =
          this.onConflict.length > 0
            ? rows.find((r) => this.onConflict.every((c) => r[c] === p[c]))
            : undefined;
        if (existing) {
          Object.assign(existing, p); // keep id + created_at
          out.push(existing);
        } else {
          const r = this.materialize(p);
          rows.push(r);
          out.push(r);
        }
      }
      if (!this.returning) return { data: null, error: null };
      return { data: this.wantSingle ? out[0] ?? null : out, error: null };
    }

    if (this.op === "delete") {
      const removed = rows.filter((r) => this.matches(r));
      const kept = rows.filter((r) => !this.matches(r));
      rows.length = 0;
      rows.push(...kept);
      if (!this.returning) return { data: null, error: null };
      return { data: this.wantSingle ? removed[0] ?? null : removed, error: null };
    }

    if (this.op === "update") {
      const targets = rows.filter((r) => this.matches(r));
      targets.forEach((r) => Object.assign(r, this.payload));
      if (!this.returning) return { data: null, error: null };
      return { data: this.wantSingle ? targets[0] ?? null : targets, error: null };
    }

    // select
    let result = rows.filter((r) => this.matches(r));
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      result = [...result].sort((a, b) => {
        const av = a[col] as number | string;
        const bv = b[col] as number | string;
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    // PostgREST applies range (inclusive, 0-based) after ordering; limit is the
    // fallback when no range was set.
    if (this.rangeFromTo) {
      result = result.slice(this.rangeFromTo.from, this.rangeFromTo.to + 1);
    } else if (this.limitN != null) {
      result = result.slice(0, this.limitN);
    }
    if (this.wantSingle) return { data: result[0] ?? null, error: null };
    return { data: result, error: null };
  }

  private materialize(p: Row): Row {
    return {
      id: p.id ?? this.db._nextId(),
      created_at: this.db._nextSeq(),
      ...p,
    };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    } catch (e) {
      return Promise.reject(e).then(onfulfilled, onrejected) as PromiseLike<TResult2>;
    }
  }
}
