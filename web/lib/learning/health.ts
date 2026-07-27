import type { SupabaseClient } from "@supabase/supabase-js";
import type { LearningModule } from "./signals";

// Stage health decides which gear the loop runs in.
//
// Incremental rules are the right response to "mostly good, with a recurring
// flaw". They are the wrong response to "half of this gets thrown away" — the
// tenth appended rule does not fix an approach that is wrong, it just makes the
// prompt longer and each individual rule easier to skim past.
//
// So a stage above the rejection threshold escalates: the analyzer is asked for
// a replacement approach instead of another bullet, and because that is a much
// bigger change than adding a rule, it never activates on its own.

export type StageHealth = {
  module: LearningModule;
  rejected: number;
  judged: number;
  reject_rate: number | null;
  needs_new_strategy: boolean;
};

export async function stageHealth(
  supabase: SupabaseClient,
): Promise<StageHealth[]> {
  const { data, error } = await supabase.from("stage_health").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as StageHealth[];
}

export async function healthFor(
  supabase: SupabaseClient,
  module: LearningModule,
): Promise<StageHealth | null> {
  try {
    const all = await stageHealth(supabase);
    return all.find((h) => h.module === module) ?? null;
  } catch {
    // Health is an input to how the loop behaves, never a precondition for it
    // running. Unknown health means "assume healthy, propose rules".
    return null;
  }
}

/** Human-readable reading for the Settings panel. */
export function describeHealth(h: StageHealth): string {
  if (!h.judged) return "no graded output yet";
  const pct = Math.round((h.reject_rate ?? 0) * 100);
  const noun =
    h.module === "drafting"
      ? "drafts needed an edit"
      : h.module === "personalization"
        ? "hooks rejected"
        : "records graded wrong";
  return `${pct}% ${noun} (${h.rejected} of ${h.judged})`;
}
