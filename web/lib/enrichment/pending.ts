import type { SupabaseClient } from "@supabase/supabase-js";

// Shared eligibility + fetch for "send to Clay" contacts, used by the Clay push
// (server action) and the CSV export (route handler).
//
// Eligible-for-Clay = pending AND vetted AND not deleted AND gate-passed AND
// never sent before:
//   enrichment_status = 'pending'
//   AND reviewed = true                    -- vet before enrich
//   AND deleted_at IS NULL                 -- soft-deleted rows never spend
//   AND (batch_id IS NULL                  -- legacy rows predate batching
//        OR batch gate_status = 'passed')  -- the gate gates spend
//   AND clay_pushed_at IS NULL             -- never pay twice for one contact
// Enrichment costs Clay credits and writes into the production Clay table, so
// only contacts a human kept AND whose batch passed grading may be pushed.
//
// The clay_pushed_at clause is the double-spend guard. Status alone can't do it:
// a contact Clay found nothing for (or never wrote back on) stays 'pending'
// forever, so before migration 021 every push re-sent — and re-billed — the
// entire un-written-back backlog. Callers that genuinely want another pass pass
// includePushed and clear the mark; nothing does it implicitly.
//
// An unbounded .select() is capped by PostgREST's max-rows (Supabase defaults to
// ~1000), which silently truncates a large pending set — the push/export then
// only covers part of it with no error. We page explicitly instead: take an
// exact count, then walk fixed-size windows ordered by a stable key, advancing
// by the number of rows actually returned (so it stays correct even if the
// server cap is smaller than the page size).

export type PendingContact = {
  id: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null; kind: string | null } | null;
};

export type EligibilityOptions = {
  /** Include contacts already sent to Clay — a deliberate re-send, which spends
   *  credits again. Off everywhere by default. */
  includePushed?: boolean;
};

const SELECT =
  "id, full_name, title, persona, linkedin_url, organizations!inner(name, domain, kind)";
const PAGE = 1000;

async function passedBatchIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("batches")
    .select("id")
    .eq("gate_status", "passed");
  if (error) throw new Error(error.message);
  return (data ?? []).map((b) => b.id as string);
}

// PostgREST or-filter for the batch clause: no batch, or a gate-passed batch.
function batchScope(passed: string[]): string {
  return passed.length
    ? `batch_id.is.null,batch_id.in.(${passed.join(",")})`
    : "batch_id.is.null";
}

// The one place the eligibility predicate is written. Both the count and the
// paged fetch build from it, so they can never drift apart.
//
// PostgREST's filter methods return `this`, so applying them preserves the
// builder's type — but expressing that in the signature makes the checker chase
// the builder's own recursive generics. The narrow structural view below plus a
// pair of casts at the boundary says the same thing without that cost, and the
// caller keeps its concrete builder type (and its .in()/.range()/.not()).
type Filterable = {
  eq(column: string, value: string | boolean): Filterable;
  is(column: string, value: null): Filterable;
  or(filters: string): Filterable;
};
function eligible<T>(q: T, passed: string[], opts?: EligibilityOptions): T {
  let query = (q as Filterable)
    .eq("enrichment_status", "pending")
    .eq("reviewed", true)
    .is("deleted_at", null)
    .or(batchScope(passed));
  if (!opts?.includePushed) query = query.is("clay_pushed_at", null);
  return query as T;
}

export async function countEligibleContacts(
  supabase: SupabaseClient,
  opts?: EligibilityOptions,
): Promise<number> {
  const passed = await passedBatchIds(supabase);
  const { count, error } = await eligible(
    supabase.from("contacts").select("id", { count: "exact", head: true }),
    passed,
    opts,
  );
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Contacts held back purely because they were already sent to Clay: pending +
// vetted + gate-passed, but already spent. Surfaced on Review so the backlog
// that "disappeared" from the eligible count is visible and re-sendable rather
// than mysteriously missing.
export async function countAlreadyPushed(supabase: SupabaseClient): Promise<number> {
  const passed = await passedBatchIds(supabase);
  const { count, error } = await eligible(
    supabase.from("contacts").select("id", { count: "exact", head: true }),
    passed,
    { includePushed: true },
  ).not("clay_pushed_at", "is", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// All eligible contacts, optionally intersected with an explicit id list (the
// review grid's selection). Ineligible ids are silently dropped — the filter is
// the authority, not the caller.
export async function fetchEligibleContacts(
  supabase: SupabaseClient,
  ids?: string[],
  opts?: EligibilityOptions,
): Promise<PendingContact[]> {
  if (ids && !ids.length) return [];
  const passed = await passedBatchIds(supabase);

  let countQuery = eligible(
    supabase.from("contacts").select("id", { count: "exact", head: true }),
    passed,
    opts,
  );
  if (ids) countQuery = countQuery.in("id", ids);
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  const total = count ?? 0;
  const all: PendingContact[] = [];
  let from = 0;
  while (all.length < total) {
    let query = eligible(supabase.from("contacts").select(SELECT), passed, opts);
    if (ids) query = query.in("id", ids);
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as PendingContact[];
    if (!batch.length) break; // safety: no progress (e.g. rows changed mid-walk)
    all.push(...batch);
    from += batch.length;
  }
  return all;
}

// Stamp the contacts a send path actually handed to Clay. Called by both the
// webhook push (rows Clay accepted) and the CSV export (rows it emitted) —
// whichever route the data takes into Clay, the credits are spent and the
// contact must not be sent again by default.
export async function markPushedToClay(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<string | undefined> {
  if (!contactIds.length) return undefined;
  const at = new Date().toISOString();
  for (let i = 0; i < contactIds.length; i += 500) {
    const { error } = await supabase
      .from("contacts")
      .update({ clay_pushed_at: at })
      .in("id", contactIds.slice(i, i + 500));
    if (error) return error.message;
  }
  return undefined;
}
