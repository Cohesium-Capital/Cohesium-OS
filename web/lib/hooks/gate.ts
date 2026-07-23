import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveGate } from "../grading/math";
import type { GateMetrics } from "../grading/gate";

// The hook-batch gate. Same math and persistence pattern as the contact gate
// (lib/grading/gate.ts computeGate), but counted over HOOKS, not contacts, and
// from the DURABLE verdict columns rather than the mutable status:
//   - a sampled hook is GRADED when verified_at is set (a human judgment,
//     which survives later status flips like TTL expiry)
//   - it HAS AN ERROR when reject_category is set
// A personalization batch's unsampled candidates become usable for drafting
// only once this gate passes — see lib/hooks/usable.ts.

/** Recompute a hook batch's gate from its verified sample and persist gate_status. */
export async function computeHookGate(
  supabase: SupabaseClient,
  batchId: string,
): Promise<GateMetrics> {
  const { data: batch } = await supabase
    .from("batches")
    .select("id, gate_status")
    .eq("id", batchId)
    .single();
  if (!batch) throw new Error(`batch ${batchId} not found`);

  const { data: s } = await supabase
    .from("settings")
    .select("gate_threshold, sample_rate, min_sample_size")
    .eq("module", "personalization")
    .maybeSingle();
  // Fallbacks mirror the seeded personalization row (0.25 per the redesign's
  // S4 contract — hooks tolerate a slightly looser gate than sourcing facts).
  const threshold = s?.gate_threshold ?? 0.25;
  const minSampleSize = s?.min_sample_size ?? 20;

  // Soft-deleted contacts leave the gate math exactly as they leave every
  // other read path — otherwise a deleted contact's still-candidate sampled
  // hook holds the batch open forever.
  const { data: sampledRows } = await supabase
    .from("hooks")
    .select("status, verified_at, reject_category, contacts!inner(id)")
    .eq("batch_id", batchId)
    .eq("sampled", true)
    .is("contacts.deleted_at", null);
  const rows = (sampledRows ?? []) as unknown as {
    status: string;
    verified_at: string | null;
    reject_category: string | null;
  }[];

  // Denominator = graded rows plus rows still awaiting a verdict. An expired,
  // never-graded row leaves the sample instead of wedging the gate open
  // forever; a verified-then-expired row stays graded (verified_at is durable).
  const gradedCount = rows.filter((r) => r.verified_at !== null).length;
  const errorCount = rows.filter((r) => r.reject_category !== null).length;
  const sampleSize =
    gradedCount +
    rows.filter((r) => r.verified_at === null && r.status === "candidate").length;

  const status = resolveGate({
    gradedCount,
    errorCount,
    sampleSize,
    minSampleSize,
    threshold,
  });

  await supabase.from("batches").update({ gate_status: status }).eq("id", batchId);

  // Snapshot every status FLIP to gate_decisions (append-only history behind
  // batches.gate_status). Recomputes happen on every verdict, so an unchanged
  // status writes nothing.
  if (status !== batch.gate_status) {
    await supabase.from("gate_decisions").insert({
      batch_id: batchId,
      status,
      graded_count: gradedCount,
      error_count: errorCount,
      sample_size: sampleSize,
      threshold,
      sample_rate: s?.sample_rate ?? null,
      min_sample_size: minSampleSize,
    });
  }

  return {
    status,
    sampleSize,
    gradedCount,
    errorCount,
    errorRate: gradedCount > 0 ? errorCount / gradedCount : 0,
    threshold,
  };
}
