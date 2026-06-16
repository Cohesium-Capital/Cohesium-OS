import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveGate, type GateStatus } from "./math";

// Batch gate computation and grade recording (supabase-js). A batch advances
// (enrich / draft / send) only once its graded sample clears the module's
// error-rate threshold. Record-level model:
//   - a sampled contact is GRADED when review_status ∈ {approved, corrected, rejected}
//   - it HAS AN ERROR when corrected or rejected (field detail lives in `grades`)

const GRADED = ["approved", "corrected", "rejected"];
const ERRORED = ["corrected", "rejected"];

export interface GateMetrics {
  status: GateStatus;
  sampleSize: number;
  gradedCount: number;
  errorCount: number;
  errorRate: number;
  threshold: number;
}

/** Recompute a batch's gate from its graded sample and persist gate_status. */
export async function computeGate(
  supabase: SupabaseClient,
  batchId: string,
): Promise<GateMetrics> {
  const { data: batch } = await supabase
    .from("batches")
    .select("id, module")
    .eq("id", batchId)
    .single();
  if (!batch) throw new Error(`batch ${batchId} not found`);

  const { data: s } = await supabase
    .from("settings")
    .select("gate_threshold, min_sample_size")
    .eq("module", batch.module)
    .maybeSingle();
  const threshold = s?.gate_threshold ?? 0.2;
  const minSampleSize = s?.min_sample_size ?? 20;

  const { count: sampleSize } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("sampled", true);

  const { count: gradedCount } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("sampled", true)
    .in("review_status", GRADED);

  const { count: errorCount } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("sampled", true)
    .in("review_status", ERRORED);

  const status = resolveGate({
    gradedCount: gradedCount ?? 0,
    errorCount: errorCount ?? 0,
    sampleSize: sampleSize ?? 0,
    minSampleSize,
    threshold,
  });

  await supabase.from("batches").update({ gate_status: status }).eq("id", batchId);

  const graded = gradedCount ?? 0;
  return {
    status,
    sampleSize: sampleSize ?? 0,
    gradedCount: graded,
    errorCount: errorCount ?? 0,
    errorRate: graded > 0 ? (errorCount ?? 0) / graded : 0,
    threshold,
  };
}

/** True if a batch has cleared its gate (legacy batches are seeded 'passed'). */
export async function batchPassed(supabase: SupabaseClient, batchId: string | null): Promise<boolean> {
  if (!batchId) return true; // legacy direct-import contacts have no batch
  const { data } = await supabase.from("batches").select("gate_status").eq("id", batchId).maybeSingle();
  return data?.gate_status === "passed";
}

export type GradeInput = {
  contactId: string;
  module: string;
  field: string;
  verdict: "correct" | "wrong" | "missing";
  correction?: string | null;
  previousValue?: string | null;
  errorCategory?: string | null;
  grader: string;
  secondsSpent?: number | null;
  runId?: string | null;
};

/** Upsert a field-level grade (unique per contact+field+run; re-grading replaces). */
export async function recordGrade(supabase: SupabaseClient, g: GradeInput): Promise<void> {
  const { error } = await supabase.from("grades").upsert(
    {
      contact_id: g.contactId,
      module: g.module,
      field: g.field,
      verdict: g.verdict,
      correction: g.correction ?? null,
      previous_value: g.previousValue ?? null,
      error_category: g.errorCategory ?? null,
      grader: g.grader,
      seconds_spent: g.secondsSpent ?? null,
      run_id: g.runId ?? null,
    },
    { onConflict: "contact_id,field,run_id" },
  );
  if (error) throw new Error(error.message);
}

/**
 * Finalize a contact's review: set its record-level status (and the legacy
 * boolean `reviewed`). Then recompute the batch gate so it can flip to
 * passed/failed as the sample fills in.
 */
export async function finalizeContact(
  supabase: SupabaseClient,
  opts: { contactId: string; status: "approved" | "corrected" | "rejected"; batchId?: string | null },
): Promise<GateMetrics | null> {
  const { error } = await supabase
    .from("contacts")
    .update({ review_status: opts.status, reviewed: true })
    .eq("id", opts.contactId);
  if (error) throw new Error(error.message);

  let batchId = opts.batchId ?? null;
  if (!batchId) {
    const { data } = await supabase.from("contacts").select("batch_id").eq("id", opts.contactId).maybeSingle();
    batchId = (data?.batch_id as string | null) ?? null;
  }
  return batchId ? computeGate(supabase, batchId) : null;
}
