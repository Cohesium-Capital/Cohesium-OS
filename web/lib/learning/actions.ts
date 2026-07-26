"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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
  const collected = await collectSignals(supabase);

  const results = [];
  for (const moduleKey of MODULES) {
    results.push(await analyzeModule(supabase, moduleKey, { trigger: "manual" }));
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

/** A rule written by hand goes in active, with the operator as its source. */
export async function addRule(
  module: LearningModule,
  ruleText: string,
): Promise<void> {
  const text = ruleText.trim();
  if (!text) throw new Error("A rule needs text.");
  const supabase = await createClient();
  const { error } = await supabase.from("prompt_rules").insert({
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
