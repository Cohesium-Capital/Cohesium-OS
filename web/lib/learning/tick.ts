import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectSignals, type LearningModule } from "./signals";
import { analyzeModule } from "./analyze";

// Opportunistic learning between cron runs.
//
// The daily cron is the floor, not the cadence: Vercel's Hobby plan allows one
// scheduled run per day, but nothing stops the loop from reacting when work
// actually happens. This runs after an ingest — the moment a batch of new
// records lands, which is also when the corrections on the PREVIOUS batch are
// most likely to be sitting unread.
//
// Two guards keep "fast" from becoming "twitchy":
//   - a floor on unprocessed signals, so it doesn't spend an API call to read
//     two edits
//   - a cooldown, so a burst of ingests in one session triggers one analysis
//
// The third guard is not here but in the activation gate: a rule needs its
// supporting corrections to span two distinct days or runs, so reacting within
// minutes still cannot encode one sitting's opinion into the prompt.

/** Enough new corrections to be worth an API call. */
const MIN_SIGNALS = 8;

/** One analysis per stage per hour, however much work happens. */
const COOLDOWN_MINUTES = 60;

async function recentlyAnalyzed(
  supabase: SupabaseClient,
  moduleKey: LearningModule,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_MINUTES * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("learning_runs")
    .select("id", { count: "exact", head: true })
    .eq("module", moduleKey)
    .gte("created_at", cutoff);
  return (count ?? 0) > 0;
}

/**
 * Collect, then analyze the given stage if it has enough unread corrections and
 * hasn't just been analyzed. Never throws: a learning failure must not fail the
 * ingest that triggered it.
 */
export async function learningTick(
  supabase: SupabaseClient,
  moduleKey: LearningModule,
): Promise<void> {
  try {
    await collectSignals(supabase);

    if (await recentlyAnalyzed(supabase, moduleKey)) return;

    const { count } = await supabase
      .from("learning_signals")
      .select("id", { count: "exact", head: true })
      .eq("module", moduleKey)
      .is("processed_at", null);
    if ((count ?? 0) < MIN_SIGNALS) return;

    await analyzeModule(supabase, moduleKey, { trigger: "cron", minSignals: MIN_SIGNALS });
  } catch {
    // Intentionally silent: the operator's ingest already succeeded, and the
    // next tick or the daily cron will pick the work up.
  }
}
