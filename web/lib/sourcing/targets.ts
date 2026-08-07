import type { SupabaseClient } from "@supabase/supabase-js";

// "Which target companies do we hold, and what are their ids?" — the lookup the
// runner could not do.
//
// find_customers_for_msps takes `mspIds`, and those are UUIDs: the API will not
// accept a name, and nothing else in the runner surface returns an id.
// /api/sourcing/known comes closest — it matches a name against every org we
// hold — but its verdict deliberately reports the matched org's NAME, for a
// human to sanity-check, not its id. So an agent asked to "source customers for
// Nova 401(k) Associates" had no way to turn that into a run, and the operator
// had to read ids out of the database by hand.
//
// Deliberately NOT the msp_stats view, which also carries yield and an
// explored/exhausted status. Two reasons: the test fixture schema has no views
// (so anything built on one is untestable where the workspace-isolation tests
// live), and "exhausted" is a judgement this endpoint would then own a second
// copy of. Re-sourcing a target is cheap and safe anyway — the known-check
// filters what has already been found — so the list stays a list.

export type TargetRow = {
  id: string;
  name: string;
  domain: string | null;
  confidence: string | null;
  reviewed: boolean;
};

export type TargetPage = {
  targets: TargetRow[];
  /**
   * `hasMore` rather than a total, because the runner reaches this through the
   * RLS adapter, which REFUSES count/head selects (they return a number where
   * it hands back rows, the one unsupported call that could pass quietly).
   * A short page means the end — the same convention loadOrgIndex pages by.
   */
  counts: { returned: number; limit: number; offset: number; hasMore: boolean };
};

const SELECT = "id, name, domain, confidence, reviewed";

/** Hard ceiling on one response. Paging is the caller's, but it cannot ask for
 *  everything at once and blow the response up on a large tenant. */
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 500;

// Plain digits only, deliberately NOT parseInt: parseInt stops at the first
// character it does not understand, so "1e9999" reads as 1 and "10.9" as 10.
// A caller passing either gets a page size they did not ask for and no
// indication of it — an agent handed one row could reasonably conclude the
// workspace has one target. Anything that is not a plain integer is treated as
// absent instead.
const digits = (v: string | null | undefined): number | null =>
  v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null;

/** Clamp a caller-supplied limit/offset to something sane. A garbage value
 *  falls back rather than erroring: this is a read, and a 400 here would only
 *  strand an agent that guessed a parameter. */
export function pageParams(rawLimit?: string | null, rawOffset?: string | null) {
  const l = digits(rawLimit);
  const o = digits(rawOffset);
  return {
    limit: l !== null && l > 0 ? Math.min(l, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: o !== null ? o : 0,
  };
}

/**
 * List a workspace's target companies, newest-agnostic and ordered by name.
 *
 * The workspace filter is not optional, for the same reason it is not optional
 * in loadOrgIndex: RLS scopes to every workspace the caller belongs to, so
 * without it a token owned by someone in two tenants would list — and hand an
 * agent run-ready ids for — the other tenant's targets.
 */
export async function listTargets(
  supabase: SupabaseClient,
  workspaceId: string,
  opts?: { limit?: number; offset?: number },
): Promise<TargetPage> {
  const limit = Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = opts?.offset ?? 0;

  const { data, error } = await supabase
    .from("organizations")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
    .eq("kind", "msp")
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Could not load target companies: ${error.message}`);

  const targets = (data ?? []) as unknown as TargetRow[];
  return {
    targets,
    counts: {
      returned: targets.length,
      limit,
      offset,
      // A full page might be the last one; the caller confirms with one more
      // request that comes back empty. Claiming otherwise would need a count.
      hasMore: targets.length === limit,
    },
  };
}
