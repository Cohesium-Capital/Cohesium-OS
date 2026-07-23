import type { SupabaseClient } from "@supabase/supabase-js";

// Shared eligibility + fetch for "send to Clay" contacts, used by the Clay push
// (server action) and the CSV export (route handler).
//
// Eligible-for-Clay = pending AND vetted AND not deleted AND gate-passed:
//   enrichment_status = 'pending'
//   AND reviewed = true                    -- vet before enrich
//   AND deleted_at IS NULL                 -- soft-deleted rows never spend
//   AND (batch_id IS NULL                  -- legacy rows predate batching
//        OR batch gate_status = 'passed')  -- the gate gates spend
// Enrichment costs Clay credits and writes into the production Clay table, so
// only contacts a human kept AND whose batch passed grading may be pushed.
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

export async function countEligibleContacts(supabase: SupabaseClient): Promise<number> {
  const passed = await passedBatchIds(supabase);
  const { count, error } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("enrichment_status", "pending")
    .eq("reviewed", true)
    .is("deleted_at", null)
    .or(batchScope(passed));
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// All eligible contacts, optionally intersected with an explicit id list (the
// review grid's selection). Ineligible ids are silently dropped — the filter is
// the authority, not the caller.
export async function fetchEligibleContacts(
  supabase: SupabaseClient,
  ids?: string[],
): Promise<PendingContact[]> {
  if (ids && !ids.length) return [];
  const passed = await passedBatchIds(supabase);

  let countQuery = supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("enrichment_status", "pending")
    .eq("reviewed", true)
    .is("deleted_at", null)
    .or(batchScope(passed));
  if (ids) countQuery = countQuery.in("id", ids);
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  const total = count ?? 0;
  const all: PendingContact[] = [];
  let from = 0;
  while (all.length < total) {
    let query = supabase
      .from("contacts")
      .select(SELECT)
      .eq("enrichment_status", "pending")
      .eq("reviewed", true)
      .is("deleted_at", null)
      .or(batchScope(passed));
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
