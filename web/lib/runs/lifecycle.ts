import type { SupabaseClient } from "@supabase/supabase-js";
import { getModule } from "../modules/registry";
import type { IngestOutcome, ModuleKey } from "../modules/types";

// Run lifecycle for the copy-paste executor (the default, free path). A run
// pairs with a batch: createRun renders the prompt the operator pastes into
// Claude.ai (status 'awaiting_input'); ingestRun validates the pasted JSON and
// writes it into the batch (status 'review_ready'). Client-agnostic — a server
// action passes a session client (RLS), a headless script the service client.
//
// The P5 runner executor will reuse ingestRun's tail (parse → ingest → status)
// after producing rawText itself via runStructured, instead of an operator
// pasting it.

// Modules whose records carry source evidence are evidence-gated; drafting
// produces message copy and is not.
const requiresEvidence = (module: ModuleKey) => module !== "drafting";

export interface CreatedRun {
  runId: string;
  batchId: string;
  promptVersionId: string | null;
  prompt: string;
}

export async function createRun(
  supabase: SupabaseClient,
  opts: {
    module: ModuleKey;
    config: Record<string, unknown>;
    label: string;
    createdBy?: string | null;
  },
): Promise<CreatedRun> {
  const mod = getModule(opts.module);

  const { data: pv } = await supabase
    .from("prompt_versions")
    .select("id, prompt")
    .eq("module", opts.module)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: batch, error: be } = await supabase
    .from("batches")
    .insert({ module: opts.module, label: opts.label })
    .select("id")
    .single();
  if (be || !batch) throw new Error(`Could not create batch: ${be?.message ?? "no row"}`);

  const { data: run, error: re } = await supabase
    .from("runs")
    .insert({
      module: opts.module,
      prompt_version_id: pv?.id ?? null,
      batch_id: batch.id,
      executor: "copy_paste",
      provider_label: "copy-paste",
      config: opts.config,
      status: "awaiting_input",
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();
  if (re || !run) throw new Error(`Could not create run: ${re?.message ?? "no row"}`);

  const prompt = mod.renderPrompt(pv?.prompt ?? null, opts.config);
  return { runId: run.id, batchId: batch.id, promptVersionId: pv?.id ?? null, prompt };
}

export async function ingestRun(
  supabase: SupabaseClient,
  opts: {
    runId: string;
    rawText: string;
    createdBy?: string | null;
    // Override the module default (e.g. the inline sourcing flow ingests
    // leniently so low-confidence rows are kept-and-flagged, not dropped).
    requireEvidence?: boolean;
  },
): Promise<IngestOutcome & { batchId?: string | null }> {
  const { data: run, error: rerr } = await supabase
    .from("runs")
    .select("id, module, batch_id, config")
    .eq("id", opts.runId)
    .single();
  if (rerr || !run) {
    return { ok: false, error: `Run not found: ${rerr?.message ?? opts.runId}`, inserted: 0, rejected: 0, sampledCount: 0, messages: [] };
  }

  const mod = getModule(run.module as ModuleKey);
  const parsed = mod.parse(opts.rawText);
  if (!parsed.ok) {
    await supabase.from("runs").update({ status: "failed", error: parsed.error, finished_at: new Date().toISOString() }).eq("id", run.id);
    return { ok: false, error: parsed.error, inserted: 0, rejected: 0, sampledCount: 0, messages: [] };
  }

  await supabase.from("runs").update({ status: "ingesting", started_at: new Date().toISOString() }).eq("id", run.id);

  const { data: s } = await supabase
    .from("settings")
    .select("sample_rate")
    .eq("module", run.module)
    .maybeSingle();
  const sampleRate = s?.sample_rate ?? 1;

  const outcome = await mod.ingest(supabase, parsed.data, {
    runId: run.id,
    batchId: run.batch_id,
    config: (run.config as Record<string, unknown>) ?? {},
    sampleRate,
    requireEvidence: opts.requireEvidence ?? requiresEvidence(run.module as ModuleKey),
    createdBy: opts.createdBy ?? null,
  });

  await supabase
    .from("runs")
    .update({
      status: outcome.ok ? "review_ready" : "failed",
      error: outcome.ok ? null : outcome.error ?? null,
      finished_at: new Date().toISOString(),
      raw_io: { rawText: opts.rawText },
    })
    .eq("id", run.id);

  return { ...outcome, batchId: run.batch_id };
}
