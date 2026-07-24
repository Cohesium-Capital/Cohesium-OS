"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { recordGrade, finalizeContact, computeGate, type GateMetrics } from "./gate";

// Grading actions for the keyboard review queue. A grader either approves a
// record (clean), corrects specific fields (records field-level grades + writes
// the fixes back so downstream uses the corrected values), or rejects it.

// Contact-level fields the grader can correct, mapped to their column.
const FIELD_COLUMN: Record<string, string> = {
  name: "full_name",
  title: "title",
  email: "email",
  phone: "phone",
  linkedin: "linkedin_url",
  personalization: "personalization",
};

export type FieldGrade = {
  field: string;
  verdict: "wrong" | "missing";
  correction?: string | null;
  previousValue?: string | null;
  errorCategory?: string | null;
};

export async function submitGrade(input: {
  contactId: string;
  module: string;
  batchId?: string | null;
  decision: "approved" | "corrected" | "rejected";
  fieldGrades?: FieldGrade[];
  secondsSpent?: number | null;
}): Promise<GateMetrics | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const grader = user.email ?? user.id;

  // Resolve the run that produced this batch so grade rows have a stable
  // (contact_id, field, run_id) key and re-grading replaces rather than duplicates.
  let runId: string | null = null;
  if (input.batchId) {
    const { data: run } = await supabase
      .from("runs")
      .select("id")
      .eq("batch_id", input.batchId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    runId = run?.id ?? null;
  }

  if (input.decision === "corrected") {
    const patch: Record<string, unknown> = {};
    for (const f of input.fieldGrades ?? []) {
      await recordGrade(supabase, {
        contactId: input.contactId,
        module: input.module,
        field: f.field,
        verdict: f.verdict,
        correction: f.correction ?? null,
        previousValue: f.previousValue ?? null,
        errorCategory: f.errorCategory ?? null,
        grader,
        secondsSpent: input.secondsSpent ?? null,
        runId,
      });
      const col = FIELD_COLUMN[f.field];
      if (col && f.correction != null) patch[col] = f.correction;
    }
    if (Object.keys(patch).length) {
      await supabase.from("contacts").update(patch).eq("id", input.contactId);
    }
  }

  const metrics = await finalizeContact(supabase, {
    contactId: input.contactId,
    status: input.decision,
    batchId: input.batchId ?? null,
  });

  revalidatePath("/review/grade");
  revalidatePath("/review");
  return metrics;
}

/** Recompute and return a batch's gate (used to refresh the queue header). */
export async function refreshGate(batchId: string): Promise<GateMetrics> {
  await requireUser();
  const supabase = await createClient();
  return computeGate(supabase, batchId);
}
