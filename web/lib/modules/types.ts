import type { SupabaseClient } from "@supabase/supabase-js";

// The shared shape every pipeline module exposes (mirrors Gradebook's
// lib/modules/*): how to render its operator prompt, how to validate the output
// the model produced, and how to ingest that output into a batch. One interface,
// two execution paths behind it — copy-paste today, the Agent-SDK runner later
// (P5) — both feeding the same ingest().

export type ModuleKey = "sourcing" | "enrichment" | "personalization" | "drafting";

export interface IngestContext {
  runId: string | null;
  batchId: string | null;
  /** the run's config (same object renderPrompt received) — carries module
   *  params an ingest needs but the output doesn't, e.g. sourcing kind/targetMsp */
  config: Record<string, unknown>;
  /** fraction of inserted records flagged for grading (from settings) */
  sampleRate: number;
  /** reject records lacking evidence to rejected_ingest rather than insert */
  requireEvidence: boolean;
  createdBy?: string | null;
}

export interface IngestOutcome {
  ok: boolean;
  error?: string;
  inserted: number; // records (contacts / touches) written
  rejected: number; // evidence-less records logged to rejected_ingest
  sampledCount: number; // inserted records flagged for grading
  messages: string[];
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface RunModule<Config = Record<string, unknown>, Output = unknown> {
  key: ModuleKey;
  /** Human label for the module's records, used in run/batch UI. */
  label: string;
  /**
   * Build the operator-facing prompt to paste into Claude.ai. `template` is the
   * active prompt_version text (the versioned instruction snapshot, for
   * provenance); `config` carries the run's runtime parameters.
   */
  renderPrompt(template: string | null, config: Config): string;
  /** Validate pasted/produced output against the module's contract. */
  parse(rawText: string): ParseResult<Output>;
  /** Persist validated output into the run's batch. */
  ingest(
    supabase: SupabaseClient,
    output: Output,
    ctx: IngestContext,
  ): Promise<IngestOutcome>;
}
