"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { recordGrade, type GateMetrics } from "@/lib/grading/gate";
import { computeHookGate } from "./gate";

// Verification actions for the hook verify queue. A grader clicks the source
// URL and answers one question in two parts: does the URL support THIS
// specific claim, AND is the claim specific to this person/company? Both
// required for 'verified'. kind='none' cards ask instead whether the fallback
// angle is honest and non-generic. Every verdict lands three places: the hook
// row (verified_by/at — the durable judgment), a grades row (the eval set
// carries positives too), and the batch gate.

export type HookVerdict = "verified" | "rejected";

// Mirrors the reject keys in verify-queue.tsx; all are legal
// grades.error_category values ('generic' joined the taxonomy in 019).
export type HookRejectCategory =
  | "hallucinated"
  | "stale_data"
  | "bad_evidence"
  | "generic"
  | "wrong_person"
  | "other";

export type VerifyHookResult = {
  metrics: GateMetrics | null;
  /** A double-submit or second grader beat this verdict — benign, skip ahead. */
  alreadyDecided?: boolean;
  /** The verdict landed but grade/gate bookkeeping failed — surface, don't trap. */
  warning?: string;
};

export async function verifyHook(input: {
  hookId: string;
  verdict: HookVerdict;
  category?: HookRejectCategory | null;
  secondsSpent?: number | null;
}): Promise<VerifyHookResult> {
  const user = await requireUser();
  const supabase = await createClient();
  const grader = user.email ?? user.id;

  if (input.verdict === "rejected" && !input.category) {
    throw new Error("Reject requires an error category.");
  }

  // Only an undecided candidate can take a verdict — the status guard makes a
  // double-submit (or a second grader racing) a no-op error, never a flip-flop.
  const { data: hook, error } = await supabase
    .from("hooks")
    .update({
      status: input.verdict,
      verified_by: grader,
      verified_at: new Date().toISOString(),
      reject_category: input.verdict === "rejected" ? input.category : null,
    })
    .eq("id", input.hookId)
    .eq("status", "candidate")
    .select("id, contact_id, batch_id, run_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!hook) {
    // The guard matched nothing. Refetch to tell the benign case (someone —
    // this grader double-clicking, or a second grader — already decided it)
    // from the real errors (missing / expired), which still throw.
    const { data: existing } = await supabase
      .from("hooks")
      .select("id, status, batch_id")
      .eq("id", input.hookId)
      .maybeSingle();
    if (existing && (existing.status === "verified" || existing.status === "rejected")) {
      let metrics: GateMetrics | null = null;
      try {
        metrics = existing.batch_id ? await computeHookGate(supabase, existing.batch_id) : null;
      } catch {
        // The queue only needs to advance; stale metrics beat a trapped card.
      }
      revalidatePath("/personalize");
      revalidatePath("/");
      return { alreadyDecided: true, metrics };
    }
    throw new Error(existing ? "Hook expired before the verdict landed." : "Hook not found.");
  }

  // The verdict as an eval-set grade: verified hooks are positive examples,
  // rejected ones carry the error category. Same (contact, field, run) upsert
  // key as every other grade, so a re-run replaces rather than duplicates.
  // The verdict itself already landed on the hook row above — a bookkeeping
  // failure here must not trap the operator on this card, so it degrades to a
  // warning instead of a throw.
  let metrics: GateMetrics | null = null;
  let warning: string | undefined;
  try {
    await recordGrade(supabase, {
      contactId: hook.contact_id,
      module: "personalization",
      field: "hook",
      verdict: input.verdict === "verified" ? "correct" : "wrong",
      correction: null,
      errorCategory: input.verdict === "rejected" ? input.category : null,
      grader,
      secondsSpent: input.secondsSpent ?? null,
      runId: hook.run_id ?? null,
    });

    // Each verdict recomputes the batch gate; unsampled candidates in this batch
    // become draftable the moment it flips to passed.
    metrics = hook.batch_id ? await computeHookGate(supabase, hook.batch_id) : null;
  } catch (e) {
    warning = `Verdict saved, but grade/gate bookkeeping failed: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }

  revalidatePath("/personalize");
  revalidatePath("/");
  return { metrics, warning };
}
