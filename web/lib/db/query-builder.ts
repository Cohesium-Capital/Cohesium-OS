import type { PoolClient } from "pg";

// A small PostgREST-shaped query builder over a raw Postgres connection.
//
// Why this exists: the runner API needs row-level security without depending on
// a JWT we can sign. Postgres enforces RLS natively once the connection assumes
// the `authenticated` role, but then every query in the request has to go over
// that connection rather than PostgREST. Rather than rewrite the shared ingest
// pipeline in SQL, this adapter presents the slice of the supabase-js interface
// that pipeline actually uses, so `createRun`, `ingestRun`, `importPayload` and
// `loadOrgIndex` run unchanged on either transport.
//
// The governing rule is FAIL LOUD. Anything not implemented here throws rather
// than approximating PostgREST's behaviour — a query builder that silently
// returns the wrong rows under an RLS boundary is far worse than one that
// crashes. `.or()`, `.not()`, embedded resource selects (`table!inner(...)`) and
// count/head queries are deliberately unimplemented: nothing in the runner call
// graph uses them, and guessing at their semantics is how you get a security
// bug that looks like a data bug.

export type PgResult<T> = { data: T | null; error: { message: string } | null };

// Filters are kept structured rather than pre-rendered because binding them
// correctly needs the column's Postgres type, which is only available at build
// time. `id = ANY($1)` with a JS array of uuid strings fails outright without an
// explicit `::uuid[]` cast — Postgres will not coerce text[] to uuid[].
type Filter =
  | { kind: "cmp"; column: string; op: "=" | "<>" | ">="; value: unknown }
  | { kind: "isLiteral"; column: string; literal: "NULL" | "TRUE" | "FALSE" }
  | { kind: "any"; column: string; values: readonly unknown[] }
  | { kind: "never" };

type Op = "select" | "insert" | "update" | "delete";

// Postgres type categories that need explicit handling when binding parameters.
// jsonb is the one that actually bites: node-postgres turns a JS array into a
// Postgres ARRAY, so `evidence: [{url}]` would be bound as an array literal
// against a jsonb column and fail. Knowing the column's real type lets us
// stringify and cast instead.
export type ColumnTypes = Map<string, string>;

const IDENT = /^[a-z_][a-z0-9_]*$/i;

function quoteIdent(name: string): string {
  const trimmed = name.trim();
  if (!IDENT.test(trimmed)) {
    throw new Error(`unsafe or unsupported column reference: ${JSON.stringify(name)}`);
  }
  return `"${trimmed}"`;
}

function parseColumns(cols: string): string {
  const trimmed = cols.trim();
  if (trimmed === "*" || trimmed === "") return "*";
  if (/[()!]/.test(trimmed)) {
    // e.g. "organizations!inner(name, domain)" — a PostgREST resource embedding.
    throw new Error(
      `embedded resource selects are not supported by the runner adapter: ${trimmed}`,
    );
  }
  return trimmed
    .split(",")
    .map((c) => quoteIdent(c))
    .join(", ");
}

export class PgQueryBuilder<T = Record<string, unknown>> implements PromiseLike<PgResult<T>> {
  // Savepoint names must be unique within a transaction's lifetime for the
  // release/rollback pairing to be unambiguous.
  private static savepointSeq = 0;

  private op: Op = "select";
  private columns = "*";
  private returning: string | null = null;
  private filters: Filter[] = [];
  private payload: Record<string, unknown>[] = [];
  private patch: Record<string, unknown> | null = null;
  private orderBy: { column: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private rowMode: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private client: PoolClient,
    private table: string,
    private types: () => Promise<ColumnTypes>,
  ) {
    quoteIdent(table);
  }

  // A second argument is PostgREST's { count, head } options. Count/head are
  // unimplemented, and unlike an unsupported filter a count returns the wrong
  // *shape* — rows where the caller expects a number — which would slip through
  // silently rather than crash. That is the one hole the fail-loud rule above
  // must not have, so reject it eagerly. Nothing in the runner call graph passes
  // it today (loadKnownOrgs' count selects run on the copy-paste path only).
  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (opts !== undefined) {
      throw new Error(
        "count/head queries are not supported by the runner adapter (select received an options argument)",
      );
    }
    if (this.op === "select") this.columns = parseColumns(cols);
    // After insert/update, .select() means RETURNING.
    else this.returning = parseColumns(cols);
    return this;
  }

  insert(rows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "cmp", column, op: "=", value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ kind: "cmp", column, op: "<>", value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ kind: "cmp", column, op: ">=", value });
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.filters.push({
      kind: "isLiteral",
      column,
      literal: value === null ? "NULL" : value ? "TRUE" : "FALSE",
    });
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    // Matches PostgREST semantics for an empty set without emitting `IN ()`.
    this.filters.push(values.length ? { kind: "any", column, values } : { kind: "never" });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }

  single(): this {
    this.rowMode = "single";
    return this;
  }

  maybeSingle(): this {
    this.rowMode = "maybeSingle";
    return this;
  }

  // Unimplemented on purpose — see the module comment. Throwing keeps an
  // unsupported filter from quietly widening a result set under RLS.
  or(): never {
    throw new Error("`.or()` is not supported by the runner adapter");
  }
  not(): never {
    throw new Error("`.not()` is not supported by the runner adapter");
  }
  ilike(): never {
    throw new Error("`.ilike()` is not supported by the runner adapter");
  }

  private bind(
    column: string,
    value: unknown,
    types: ColumnTypes,
    params: unknown[],
  ): string {
    const type = types.get(column);
    // json/jsonb: hand Postgres a string and cast, so objects AND arrays both
    // land as JSON rather than being reinterpreted as Postgres arrays.
    if (type === "jsonb" || type === "json") {
      params.push(value === null ? null : JSON.stringify(value));
      return `$${params.length}::${type}`;
    }
    params.push(value);
    // Cast scalars to the column's own type so an untyped text parameter is
    // never compared against a uuid/timestamptz column.
    return type && value !== null ? `$${params.length}::${type}` : `$${params.length}`;
  }

  private renderFilters(types: ColumnTypes, params: unknown[]): string {
    if (!this.filters.length) return "";
    const parts = this.filters.map((f) => {
      switch (f.kind) {
        case "never":
          return "FALSE";
        case "isLiteral":
          return `${quoteIdent(f.column)} IS ${f.literal}`;
        case "cmp":
          return `${quoteIdent(f.column)} ${f.op} ${this.bind(f.column, f.value, types, params)}`;
        case "any": {
          const type = types.get(f.column);
          params.push(f.values);
          // The array cast is what makes `id = ANY($n)` work against uuid,
          // timestamptz and enum-ish text columns alike.
          return `${quoteIdent(f.column)} = ANY($${params.length}${type ? `::${type}[]` : ""})`;
        }
      }
    });
    return ` WHERE ${parts.join(" AND ")}`;
  }

  private async build(): Promise<{ text: string; params: unknown[] }> {
    const types = await this.types();
    const params: unknown[] = [];
    const table = quoteIdent(this.table);

    const tailSql = (): string => {
      let s = "";
      if (this.orderBy.length) {
        s += ` ORDER BY ${this.orderBy
          .map((o) => `${quoteIdent(o.column)} ${o.ascending ? "ASC" : "DESC"}`)
          .join(", ")}`;
      }
      if (this.limitN !== null) s += ` LIMIT ${Number(this.limitN)}`;
      if (this.offsetN !== null) s += ` OFFSET ${Number(this.offsetN)}`;
      return s;
    };

    if (this.op === "select") {
      return {
        text: `SELECT ${this.columns} FROM ${table}${this.renderFilters(types, params)}${tailSql()}`,
        params,
      };
    }

    if (this.op === "insert") {
      if (!this.payload.length) throw new Error("insert called with no rows");
      // Union of keys across rows so a heterogeneous batch still lines up;
      // missing keys bind as NULL and take the column default only if absent
      // from every row.
      const cols = [...new Set(this.payload.flatMap((r) => Object.keys(r)))];
      const colSql = cols.map(quoteIdent).join(", ");
      const tuples: string[] = [];
      for (const row of this.payload) {
        const placeholders: string[] = [];
        for (const c of cols) {
          placeholders.push(this.bind(c, row[c] ?? null, types, params));
        }
        tuples.push(`(${placeholders.join(", ")})`);
      }
      const ret = this.returning ? ` RETURNING ${this.returning}` : "";
      return {
        text: `INSERT INTO ${table} (${colSql}) VALUES ${tuples.join(", ")}${ret}`,
        params,
      };
    }

    if (this.op === "update") {
      if (!this.patch || !Object.keys(this.patch).length) {
        throw new Error("update called with an empty patch");
      }
      const sets: string[] = [];
      for (const [c, v] of Object.entries(this.patch)) {
        sets.push(`${quoteIdent(c)} = ${this.bind(c, v, types, params)}`);
      }
      const ret = this.returning ? ` RETURNING ${this.returning}` : "";
      return {
        text: `UPDATE ${table} SET ${sets.join(", ")}${this.renderFilters(types, params)}${ret}`,
        params,
      };
    }

    const ret = this.returning ? ` RETURNING ${this.returning}` : "";
    return { text: `DELETE FROM ${table}${this.renderFilters(types, params)}${ret}`, params };
  }

  async run(): Promise<PgResult<T>> {
    let text: string;
    let params: unknown[];
    try {
      ({ text, params } = await this.build());
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }

    // Each statement runs inside its own savepoint.
    //
    // This is not an optimisation, it is the whole reason this transport is
    // safe. The shared pipeline was written against PostgREST, where a failed
    // statement is isolated and the caller decides whether to continue — and it
    // *relies* on that: importPayload logs a failed contacts insert and carries
    // on, and resolvePromptVersion deliberately provokes a unique violation to
    // detect a race. On a single Postgres transaction the first such failure
    // aborts everything after it, and COMMIT on an aborted transaction silently
    // rolls back, so the pipeline would report a successful ingest that wrote
    // nothing. The savepoint restores statement-level isolation while keeping
    // the request as a whole atomic.
    const sp = `pgq_${++PgQueryBuilder.savepointSeq}`;
    try {
      await this.client.query(`SAVEPOINT ${sp}`);
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }

    try {
      const res = await this.client.query(text, params);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      const rows = res.rows as unknown[];

      if (this.rowMode === "single") {
        if (rows.length !== 1) {
          return {
            data: null,
            error: {
              message: `expected exactly one row, got ${rows.length}`,
            },
          };
        }
        return { data: rows[0] as T, error: null };
      }
      if (this.rowMode === "maybeSingle") {
        if (rows.length > 1) {
          return { data: null, error: { message: `expected at most one row, got ${rows.length}` } };
        }
        return { data: (rows[0] ?? null) as T, error: null };
      }

      // An insert/update with no RETURNING yields no rows; supabase-js reports
      // data:null there, which callers already handle.
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      return { data: rows as unknown as T, error: null };
    } catch (e) {
      // Unwind to the savepoint so the surrounding transaction stays usable.
      try {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // Connection itself is gone; withRls will roll the transaction back.
      }
      // Surfaced, never thrown: every caller in the shared pipeline checks
      // `error` and reports it. Throwing here would bypass that handling and
      // abort a partially-applied ingest without its diagnostics.
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }

  then<R1 = PgResult<T>, R2 = never>(
    onfulfilled?: ((value: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}
