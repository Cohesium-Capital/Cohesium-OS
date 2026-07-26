import type { SupabaseClient } from "@supabase/supabase-js";

// Run scoping for the pipeline pages. A stage page normally works across every
// contact at that stage; arriving from a run's timeline entry (?run=<id>) narrows
// it to the records that run produced, so "Personalize" on run 16-C personalizes
// 16-C's contacts rather than everything waiting.
//
// Attribution comes from the contact_runs view (migration 024), which prefers
// contacts.run_id and falls back to the run owning the contact's batch.

export type RunScope = {
  runId: string;
  /** Short identifier, e.g. "16-C". Null if the run predates identifiers. */
  code: string | null;
  runAt: string | null;
  /** Contacts this run produced. Empty is meaningful: the run made nothing. */
  contactIds: string[];
};

export type ContactRunInfo = { runId: string; code: string | null; runAt: string | null };

/** Resolve a ?run= parameter into its contacts. Null when no run is requested. */
export async function loadRunScope(
  supabase: SupabaseClient,
  runId: string | null | undefined,
): Promise<RunScope | null> {
  if (!runId) return null;

  // Read the entry from flow_runs first: it carries the label (a run with no
  // records still names itself in the banner) and tells us how to resolve the
  // records. Pre-run-tracking batches are timeline entries too, and their
  // contacts hang off batch_id with no run to join through.
  const { data: entry } = await supabase
    .from("flow_runs")
    .select("run_code, created_at, entry_kind, batch_id")
    .eq("id", runId)
    .maybeSingle();

  const contactIds =
    entry?.entry_kind === "batch" && entry.batch_id
      ? ((
          await supabase
            .from("contacts")
            .select("id")
            .eq("batch_id", entry.batch_id as string)
            .is("deleted_at", null)
        ).data ?? []).map((r) => r.id as string)
      : ((await supabase.from("contact_runs").select("contact_id").eq("run_id", runId))
          .data ?? []).map((r) => r.contact_id as string);

  return {
    runId,
    code: (entry?.run_code as string | null) ?? null,
    runAt: (entry?.created_at as string | null) ?? null,
    contactIds,
  };
}

/** Run identifier + date per contact, for the Run / Run date columns. */
export async function contactRunMap(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<Map<string, ContactRunInfo>> {
  const map = new Map<string, ContactRunInfo>();
  if (!contactIds.length) return map;

  const { data } = await supabase
    .from("contact_runs")
    .select("contact_id, run_id, run_code, run_at")
    .in("contact_id", contactIds);

  (data ?? []).forEach((r) => {
    map.set(r.contact_id as string, {
      runId: r.run_id as string,
      code: (r.run_code as string | null) ?? null,
      runAt: (r.run_at as string | null) ?? null,
    });
  });
  return map;
}

/** Intersect a working set with a run scope. No scope leaves the set untouched. */
export function applyScope<T>(
  rows: T[],
  scope: RunScope | null,
  idOf: (row: T) => string,
): T[] {
  if (!scope) return rows;
  const allowed = new Set(scope.contactIds);
  return rows.filter((r) => allowed.has(idOf(r)));
}
