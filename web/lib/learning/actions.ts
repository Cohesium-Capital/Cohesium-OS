"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
import { collectSignals, type LearningModule } from "./signals";
import { analyzeModule } from "./analyze";
import { activateRule, rejectRule, retireRule } from "./rules";

// Operator controls for the learning loop. The loop runs itself on the daily
// cron; these exist so a human can look at what it learned, run it on demand,
// and — the important one — take a rule back out.

const MODULES: LearningModule[] = ["drafting", "personalization", "sourcing"];

async function actor(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? data.user?.id ?? "unknown";
}

/** Collect signals and analyze every module now. Returns a human summary. */
export async function runLearningNow(): Promise<string[]> {
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();
  const collected = await collectSignals(supabase, workspaceId);

  const results = [];
  for (const moduleKey of MODULES) {
    results.push(await analyzeModule(supabase, moduleKey, workspaceId, { trigger: "manual" }));
  }

  revalidatePath("/settings");
  return [
    `Collected ${collected} new correction(s).`,
    ...results.map((r) =>
      r.error
        ? `${r.module}: failed — ${r.error}`
        : r.skipped
          ? `${r.module}: skipped — ${r.skipped}`
          : `${r.module}: ${r.proposed} proposed, ${r.autoActivated} activated automatically (from ${r.signalsConsidered} corrections).`,
    ),
  ];
}

export async function approveRule(ruleId: string): Promise<void> {
  const supabase = await createClient();
  await activateRule(supabase, ruleId, await actor());
  revalidatePath("/settings");
}

export async function dropRule(ruleId: string, reason: string): Promise<void> {
  const supabase = await createClient();
  await retireRule(supabase, ruleId, await actor(), reason || "retired by operator");
  revalidatePath("/settings");
}

export async function dismissRule(ruleId: string, reason: string): Promise<void> {
  const supabase = await createClient();
  await rejectRule(supabase, ruleId, await actor(), reason || "rejected by operator");
  revalidatePath("/settings");
}

/**
 * Typed feedback on a stage's prompt. This is the highest-quality signal the
 * loop can get — the operator saying what is wrong in their own words, instead
 * of the analyzer inferring it from diffs — so it enters the same pipeline as
 * every other correction and is analyzed immediately rather than at the next
 * cron.
 */
export async function submitPromptFeedback(
  moduleKey: LearningModule,
  note: string,
): Promise<string[]> {
  const text = note.trim();
  if (text.length < 4) throw new Error("Say a little more than that.");

  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();
  const who = await actor();

  const { error } = await supabase.from("learning_signals").insert({
    workspace_id: workspaceId,
    module: moduleKey,
    kind: "operator_note",
    scope: {},
    before_text: null,
    after_text: text,
    category: "operator_note",
    ref_table: "operator_note",
    // Operator notes have no source row to key on; a fresh id keeps the
    // (ref_table, ref_id, kind) uniqueness meaningful without inventing one.
    ref_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  // Analyze this stage right away: feedback typed into a box should visibly do
  // something, not sit until 14:00 UTC tomorrow. minSignals 1 because a
  // deliberate note is worth reading on its own.
  const result = await analyzeModule(supabase, moduleKey, workspaceId, {
    trigger: "manual",
    minSignals: 1,
  });
  revalidatePath("/settings");

  return [
    `Feedback recorded by ${who}.`,
    result.error
      ? `Analysis failed: ${result.error}`
      : result.skipped
        ? `Analysis skipped: ${result.skipped}`
        : `${result.proposed} proposal(s) from ${result.signalsConsidered} correction(s) — review them below.`,
  ];
}

/** A rule written by hand goes in active, with the operator as its source. */
export async function addRule(
  module: LearningModule,
  ruleText: string,
): Promise<void> {
  const text = ruleText.trim();
  if (!text) throw new Error("A rule needs text.");
  const supabase = await createClient();
  const { error } = await supabase.from("prompt_rules").insert({
    workspace_id: await currentWorkspaceId(),
    module,
    rule_text: text,
    status: "active",
    source: "human",
    support_count: 0,
    created_by: await actor(),
    decided_by: await actor(),
    activated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}
