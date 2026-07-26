// Intentionally not marked "server-only": importing `pg` already makes this
// unbundlable for the browser, and the marker would block the integration test
// that proves the RLS guard actually works — which is worth far more here than
// a redundant import-time assertion.
import { Pool, type PoolClient } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PgQueryBuilder, type ColumnTypes } from "./query-builder";

// Row-level security over a direct Postgres connection.
//
// This is the durable alternative to minting a Supabase user JWT. Supabase is
// migrating to asymmetric JWT signing keys, whose private key we cannot hold, so
// signing our own user tokens is a mechanism with an expiry date. Postgres, by
// contrast, will enforce RLS for as long as Postgres exists: assume the
// `authenticated` role, set the JWT claims the policies read, and every
// statement on that connection is filtered exactly as it would be for that
// user's browser session.
//
// THE CRITICAL INVARIANT: the connection role. We connect as `postgres`, which
// carries rolbypassrls — every policy is ignored until `SET LOCAL ROLE
// authenticated` takes effect. So withRls does not merely issue that statement;
// it verifies afterwards that the role actually changed, and aborts the
// transaction if not. A silent failure there would turn every runner request
// into a full-database read.

const CLAIMS_GUC = "request.jwt.claims";

// Serverless-shaped pool. Small max because each function instance keeps its own
// pool and Postgres connections are the scarce resource; short idle timeout so
// instances that go quiet release them promptly.
let pool: Pool | null = null;

// A local/dev Postgres typically has TLS disabled and will reject the
// handshake; a hosted one always requires it.
function isLocal(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  } catch {
    return false;
  }
}

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL is not set — the runner API needs a Postgres connection to enforce RLS.",
    );
  }
  pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase requires TLS; its pooler presents a cert chain Node doesn't ship
    // a root for, which is why verification is relaxed rather than disabled —
    // the connection is still encrypted. A local Postgres usually has TLS off
    // entirely and refuses the handshake, so this is host-conditional.
    ssl: isLocal(connectionString) ? false : { rejectUnauthorized: false },
  });
  // An idle-client error (pooler recycling a connection) must not take the
  // process down; the pool discards the client and the next checkout reconnects.
  pool.on("error", () => {});
  return pool;
}

// Column types per table, cached for the lifetime of the instance. Needed so the
// builder can bind json/jsonb parameters correctly; the schema does not change
// between deploys, so one lookup per table per instance is right.
const typeCache = new Map<string, ColumnTypes>();

async function columnTypes(client: PoolClient, table: string): Promise<ColumnTypes> {
  const cached = typeCache.get(table);
  if (cached) return cached;
  const { rows } = await client.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const map: ColumnTypes = new Map(rows.map((r) => [r.column_name, r.udt_name]));
  typeCache.set(table, map);
  return map;
}

/**
 * The supabase-js-shaped surface the shared pipeline consumes. Structurally
 * compatible with the parts of SupabaseClient that createRun / ingestRun /
 * importPayload / loadOrgIndex touch.
 */
export type RlsClient = { from(table: string): PgQueryBuilder };

/**
 * Run `fn` inside one transaction acting as `ownerId`, with RLS enforced.
 *
 * Everything the callback does is atomic: a failed ingest leaves no partial
 * rows, which is stronger than the PostgREST path where each statement commits
 * on its own.
 */
export async function withRls<T>(
  ownerId: string,
  fn: (db: RlsClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Order matters: set the claims first so a policy evaluated during the role
    // switch can never see an authenticated role with no subject.
    await client.query(`SELECT set_config($1, $2, true)`, [
      CLAIMS_GUC,
      JSON.stringify({ sub: ownerId, role: "authenticated" }),
    ]);
    await client.query("SET LOCAL ROLE authenticated");

    // Verify rather than assume. If the role did not take, we would be running
    // as a rolbypassrls superuser with a user's claims — the worst possible
    // combination, and invisible without this check.
    const check = await client.query<{ role: string; uid: string | null }>(
      "SELECT current_user AS role, auth.uid()::text AS uid",
    );
    const { role, uid } = check.rows[0] ?? {};
    if (role !== "authenticated") {
      throw new Error(`RLS guard failed: connection is running as "${role}", not "authenticated"`);
    }
    if (uid !== ownerId) {
      throw new Error("RLS guard failed: auth.uid() does not match the token owner");
    }

    const result = await fn({
      from: (table: string) => new PgQueryBuilder(client, table, () => columnTypes(client, table)),
    });

    // COMMIT on an aborted transaction does NOT raise — Postgres quietly
    // rolls back and reports "ROLLBACK" as the command tag. Left unchecked,
    // that is the worst failure this transport can produce: a route returning
    // "imported 25 contacts" having written nothing at all. Statement-level
    // savepoints should keep the transaction out of that state; this makes it
    // impossible for one to slip through unnoticed.
    const commit = await client.query("COMMIT");
    if (commit.command === "ROLLBACK") {
      throw new Error(
        "transaction was aborted and rolled back on commit — no changes were saved",
      );
    }
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already unusable; releasing it below discards it.
    }
    throw e;
  } finally {
    // RESET ROLE is implicit at transaction end (SET LOCAL), but the pooler may
    // hand this connection to another request, so be explicit.
    try {
      await client.query("RESET ROLE");
    } catch {
      /* connection being discarded */
    }
    client.release();
  }
}

/**
 * The shared pipeline is typed against SupabaseClient. The adapter implements
 * the subset it actually calls — verified by the runner adapter tests, and by
 * the builder throwing on anything unimplemented rather than approximating it.
 */
export const asSupabase = (db: RlsClient): SupabaseClient => db as unknown as SupabaseClient;

/** Drop the cached pool and column types so a test can repoint SUPABASE_DB_URL. */
export function resetPoolForTests(): void {
  void pool?.end().catch(() => {});
  pool = null;
  typeCache.clear();
}
