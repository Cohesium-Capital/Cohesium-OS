import type { SupabaseClient } from "@supabase/supabase-js";
import type { LearningModule } from "./signals";

// The learned layer of every prompt.
//
// Git owns the prompt's structure: the JSON contract, the voice, the worked
// examples. This owns a bounded list of corrections rendered on top of it. The
// split is deliberate — an automatic loop that could rewrite the whole prompt
// would eventually mangle the contract, and a bad learned rule has to be one
// click from gone.
//
// Rules render into templateText(), which the run lifecycle hashes into
// prompt_versions. So activating a rule automatically mints a new version and
// draft_outcomes measures it, with no extra bookkeeping.

export type PromptRule = {
  id: string;
  module: LearningModule;
  scope: Record<string, unknown>;
  rule_text: string;
  rationale: string | null;
  status: "proposed" | "active" | "retired" | "rejected";
  evidence: { signal_id?: string; before?: string | null; after?: string | null }[];
  support_count: number;
  confidence: number | null;
  source: "analyzer" | "human";
  activated_at: string | null;
  retired_at: string | null;
  created_at: string;
};

/**
 * How many DISTINCT human corrections must support a rule before it activates
 * on its own. Two is too eager (one bad day of edits becomes doctrine); three
 * is a pattern. Everything below the bar waits for a human on Settings.
 */
export const AUTO_ACTIVATE_SUPPORT = 3;

/** Minimum analyzer confidence for automatic activation. */
export const AUTO_ACTIVATE_CONFIDENCE = 0.7;

/**
 * Ceiling on active rules per module. A prompt that accumulates thirty learned
 * rules stops being a prompt and starts being a rulebook the model skims — and
 * the newest lesson competes with a stale one nobody remembers adding. At the
 * cap, a new rule must displace an existing one rather than pile on.
 */
export const MAX_ACTIVE_RULES = 8;

export async function activeRules(
  supabase: SupabaseClient,
  module: LearningModule,
  workspaceId: string,
): Promise<PromptRule[]> {
  const { data, error } = await supabase
    .from("prompt_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("module", module)
    .eq("status", "active")
    .order("activated_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PromptRule[];
}

/** Rules whose scope matches the run — a LinkedIn lesson stays on LinkedIn. */
export function rulesForScope(
  rules: PromptRule[],
  scope: Record<string, unknown>,
): PromptRule[] {
  return rules.filter((r) =>
    Object.entries(r.scope ?? {}).every(([k, v]) => {
      // A null/absent value in the rule's scope means "applies everywhere".
      if (v === null || v === undefined || v === "any") return true;
      return scope[k] === undefined || scope[k] === v;
    }),
  );
}

/**
 * The block appended to a module's prompt template. Empty string when nothing
 * is active, so a module with no learned rules keeps its original prompt shape
 * — and therefore its original hash and version lineage.
 */
export function renderRuleBlock(rules: PromptRule[]): string {
  if (!rules.length) return "";
  const lines = rules.map((r) => `- ${r.rule_text}`).join("\n");
  return [
    "Learned from previous human edits (these come from real corrections to earlier",
    "output — follow them as strictly as the rules above):",
    lines,
  ].join("\n");
}

/** Convenience: load + scope-filter + render, for a module's prepareConfig. */
export async function learnedRuleBlock(
  supabase: SupabaseClient,
  module: LearningModule,
  workspaceId: string,
  scope: Record<string, unknown> = {},
): Promise<{ block: string; rules: PromptRule[] }> {
  try {
    const all = await activeRules(supabase, module, workspaceId);
    const scoped = rulesForScope(all, scope);
    return { block: renderRuleBlock(scoped), rules: scoped };
  } catch {
    // A prompt must never fail to build because the learning tables are
    // unavailable (not yet migrated, RLS, outage). No rules is a valid state.
    return { block: "", rules: [] };
  }
}

export async function activateRule(
  supabase: SupabaseClient,
  ruleId: string,
  decidedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from("prompt_rules")
    .update({
      status: "active",
      activated_at: new Date().toISOString(),
      decided_by: decidedBy,
      retired_at: null,
      retire_reason: null,
    })
    .eq("id", ruleId);
  if (error) throw new Error(error.message);
}

export async function retireRule(
  supabase: SupabaseClient,
  ruleId: string,
  decidedBy: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("prompt_rules")
    .update({
      status: "retired",
      retired_at: new Date().toISOString(),
      retire_reason: reason,
      decided_by: decidedBy,
    })
    .eq("id", ruleId);
  if (error) throw new Error(error.message);
}

export async function rejectRule(
  supabase: SupabaseClient,
  ruleId: string,
  decidedBy: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("prompt_rules")
    .update({ status: "rejected", decided_by: decidedBy, retire_reason: reason })
    .eq("id", ruleId);
  if (error) throw new Error(error.message);
}
