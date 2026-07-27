import type { SupabaseClient } from "@supabase/supabase-js";

// The shared shape every pipeline module exposes (mirrors Gradebook's
// lib/modules/*): how to render its operator prompt, how to validate the output
// the model produced, and how to ingest that output into a batch. One interface,
// two execution paths behind it — copy-paste today, the Agent-SDK runner later
// (P5) — both feeding the same ingest().

export type ModuleKey = "sourcing" | "enrichment" | "personalization" | "drafting";

/**
 * How a run's AI work is executed. 'copy_paste' is the operator pasting the
 * prompt into a chat window; 'runner' is an agent session (Claude Code) driving
 * the run through the API. The distinction changes what a prompt should carry:
 * a copy-paste prompt must be self-contained, while a runner can query the API
 * mid-run and therefore needs no embedded snapshot of the database.
 */
export type Executor = "copy_paste" | "runner";

export interface IngestContext {
  runId: string | null;
  batchId: string | null;
  /** Workspace every row this ingest writes belongs to. Derived from the run,
   *  so it is a fact about the data rather than a guess about the caller —
   *  which is what makes it correct for cron and runner paths too. */
  workspaceId: string;
  /** the run's prompt version — stamped on produced records (touches) so
   *  outcomes can be attributed back to the prompt */
  promptVersionId?: string | null;
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
  /**
   * Optional server-side enrichment of the run config, applied by createRun
   * before the prompt is rendered or hashed. This is where a module reads the
   * database to make the prompt aware of prior runs — sourcing uses it to pass
   * the already-sourced companies so the model doesn't research them twice.
   * The returned config is what gets persisted on the run, so the prompt and
   * its recorded config always agree. `notes` are operator-facing lines about
   * what the preparation did.
   *
   * `ctx.executor` matters because the two executors need different prompts:
   * copy-paste has one shot at a self-contained prompt, while a runner can call
   * the API for the same information without a size limit.
   */
  prepareConfig?(
    supabase: SupabaseClient,
    config: Config,
    ctx: { executor: Executor; workspaceId: string },
  ): Promise<{ config: Config; notes?: string[] }>;
  /**
   * The static instruction portion of the rendered prompt, volatile config
   * values replaced by {{placeholders}}; hashed for mechanical prompt
   * versioning (createRun auto-registers a prompt_version per new hash).
   */
  templateText?(config: Config): string;
  /** Validate pasted/produced output against the module's contract. */
  parse(rawText: string): ParseResult<Output>;
  /** Persist validated output into the run's batch. */
  ingest(
    supabase: SupabaseClient,
    output: Output,
    ctx: IngestContext,
  ): Promise<IngestOutcome>;
}
