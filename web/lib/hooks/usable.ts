import type { SupabaseClient } from "@supabase/supabase-js";

// The canonical "usable hook" definition — the single place that answers
// "which hook, if any, does drafting consume for this contact?". Every
// consumer (the Personalize workspace, drafting, the rent check behind
// touches.hook_id) must read hooks through here or the definitions drift and
// the hooks-vs-fallback comparison stops meaning anything.
//
// USABLE = the latest hook per contact where:
//   - status='verified', OR status='candidate' AND sampled=false AND its
//     batch's gate passed (the unsampled riders of a passed batch);
//   - researched within HOOK_TTL_DAYS (hooks rot — a 45-day-old "recent
//     talk" is no longer a warm opener);
//   - the source, when dated, was published within SOURCE_MAX_AGE_MONTHS.
// kind='none' rows follow the same rules and are usable as fallback_angle
// carriers — "no hook" is a first-class outcome, not an error. Usage is
// derived from touches.hook_id; status never flips to 'used' here or anywhere.

export const HOOK_TTL_DAYS = 45;
export const SOURCE_MAX_AGE_MONTHS = 12;

/** ISO timestamp HOOK_TTL_DAYS ago — hooks created before this are expired. */
export function hookTtlCutoff(now = new Date()): string {
  return new Date(now.getTime() - HOOK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** True when a dated source still counts as recent (undated always passes). */
export function sourceIsFresh(publishedAt: string | null, now = new Date()): boolean {
  if (!publishedAt) return true;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - SOURCE_MAX_AGE_MONTHS);
  return new Date(publishedAt) >= cutoff;
}

export type UsableHook = {
  id: string;
  contact_id: string;
  text: string | null;
  kind: string;
  fallback_angle: string | null;
  source_url: string | null;
  source_published_at: string | null;
  created_at: string;
};

type HookStateRow = UsableHook & {
  status: string;
  sampled: boolean;
  batch_id: string | null;
  batches: { gate_status: string } | null;
};

export type HookCoverage = {
  /** contact_id → its latest usable hook (drafting consumes exactly this). */
  usable: Map<string, UsableHook>;
  /**
   * Contacts with a live candidate still in flight — sampled and awaiting a
   * verdict, or riding a batch whose gate hasn't decided. Not usable yet, but
   * re-researching them would just duplicate work, so the Personalize page
   * keeps them out of the "needs hooks" list. A failed gate drops the whole
   * batch back to re-research. Disjoint from `usable`.
   */
  pending: Set<string>;
};

/**
 * One hooks query + batch gate join, classified per the canonical definition.
 * Soft-deleted contacts are excluded like every other read path.
 */
export async function hookCoverage(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<HookCoverage> {
  const { data } = await supabase
    .from("hooks")
    .select(
      "id, contact_id, text, kind, fallback_angle, source_url, source_published_at, status, sampled, created_at, batch_id, batches(gate_status), contacts!inner(id)",
    )
    .eq("workspace_id", workspaceId)
    .in("status", ["verified", "candidate"])
    .gte("created_at", hookTtlCutoff())
    .is("contacts.deleted_at", null)
    .order("created_at", { ascending: true });

  const usable = new Map<string, UsableHook>();
  const pending = new Set<string>();

  // Ascending order + overwrite = the LATEST qualifying hook wins per contact.
  for (const row of (data ?? []) as unknown as HookStateRow[]) {
    const fresh = sourceIsFresh(row.source_published_at);

    if (row.status === "verified") {
      // A human confirmed the claim; only source rot disqualifies it.
      if (fresh) usable.set(row.contact_id, toUsable(row));
      continue;
    }
    // status === 'candidate'. Unlike legacy batch-less CONTACTS (explicitly
    // backfilled as approved), a batch-less candidate hook has simply bypassed
    // the gate — nothing vouches for it, and no gate will ever decide it, so
    // it is neither usable nor in-flight: it falls back into "needs research".
    if (!row.batch_id) continue;
    const gate = row.batches?.gate_status ?? "open";
    if (gate === "failed") continue; // batch condemned — re-research
    if (!row.sampled && gate === "passed") {
      // Unsampled rider of a passed batch: usable while the source is fresh.
      if (fresh) usable.set(row.contact_id, toUsable(row));
      continue;
    }
    // Sampled and awaiting a verdict, or the batch gate is still open.
    pending.add(row.contact_id);
  }

  // A contact with a usable hook isn't "in flight" for planning purposes.
  for (const id of usable.keys()) pending.delete(id);

  return { usable, pending };
}

/** Convenience for consumers that only need the drafting-side map. */
export async function usableHooksByContact(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, UsableHook>> {
  return (await hookCoverage(supabase, workspaceId)).usable;
}

function toUsable(row: HookStateRow): UsableHook {
  return {
    id: row.id,
    contact_id: row.contact_id,
    text: row.text,
    kind: row.kind,
    fallback_angle: row.fallback_angle,
    source_url: row.source_url,
    source_published_at: row.source_published_at,
    created_at: row.created_at,
  };
}
