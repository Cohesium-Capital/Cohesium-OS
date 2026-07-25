"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { recordGrade, finalizeContact, computeGate, type GateMetrics } from "./gate";

// Grading actions for the keyboard review queue. A grader either approves a
// record (clean), corrects specific fields (records field-level grades + writes
// the fixes back so downstream uses the corrected values), or rejects it.
// Every decision persists grade rows — approvals included — so the eval set
// carries positives, not just failures.

// Contact-level fields the grader can correct, mapped to their column.
const FIELD_COLUMN: Record<string, string> = {
  name: "full_name",
  title: "title",
  email: "email",
  phone: "phone",
  linkedin: "linkedin_url",
  personalization: "personalization",
};

// Fields graded per module — mirrors FIELDS_BY_MODULE in grade-queue.tsx, so an
// approval records a 'correct' verdict for exactly what the grader saw.
const MODULE_FIELDS: Record<string, string[]> = {
  sourcing: ["name", "title", "linkedin"],
  enrichment: ["email", "phone", "linkedin"],
  personalization: ["personalization"],
  drafting: ["personalization"],
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
  // Reject only: why the whole record is wrong (+ optional free-text reason).
  errorCategory?: string | null;
  reason?: string | null;
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

  if (input.decision === "approved") {
    // A clean approve is a positive eval example for every field the queue showed.
    for (const field of MODULE_FIELDS[input.module] ?? MODULE_FIELDS.sourcing) {
      await recordGrade(supabase, {
        contactId: input.contactId,
        module: input.module,
        field,
        verdict: "correct",
        grader,
        secondsSpent: input.secondsSpent ?? null,
        runId,
      });
    }
  }

  if (input.decision === "rejected") {
    if (!input.errorCategory) throw new Error("Reject requires an error category.");
    // One record-level grade: the whole row is wrong, not a specific field.
    await recordGrade(supabase, {
      contactId: input.contactId,
      module: input.module,
      field: "record",
      verdict: "wrong",
      correction: input.reason ?? null,
      previousValue: null,
      errorCategory: input.errorCategory,
      grader,
      secondsSpent: input.secondsSpent ?? null,
      runId,
    });
  }

  if (input.decision === "corrected") {
    const patch: Record<string, unknown> = {};
    for (const f of input.fieldGrades ?? []) {
      if (!f.errorCategory) throw new Error(`Correction to "${f.field}" needs an error category.`);
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
