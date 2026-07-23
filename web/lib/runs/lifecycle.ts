import type { SupabaseClient } from "@supabase/supabase-js";
import { getModule } from "../modules/registry";
import { templateHash } from "../prompts/hash";
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

// Prompts live in git; versioning is mechanical. When a module exposes
// templateText, its template (config replaced by {{placeholders}}) is hashed
// and resolved to a prompt_versions row — an unseen (module, template_hash)
// auto-registers the next version, so attribution never depends on a human
// remembering to sync a snapshot.
async function resolvePromptVersion(
  supabase: SupabaseClient,
  module: ModuleKey,
  template: string,
): Promise<{ id: string | null; hash: string }> {
  const hash = templateHash(template);

  // Match even inactive/retired versions — the hash is the identity.
  const { data: existing } = await supabase
    .from("prompt_versions")
    .select("id")
    .eq("module", module)
    .eq("template_hash", hash)
    .maybeSingle();
  if (existing) return { id: existing.id, hash };

  const { data: latest } = await supabase
    .from("prompt_versions")
    .select("version")
    .eq("module", module)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version ?? 0) + 1;

  // One active version per module, kept in an order that can never strand the
  // module with zero active versions: insert the new row INACTIVE (an insert
  // failure then mutates nothing), promote it, and only after promotion
  // succeeds retire the others.
  const { data: created, error } = await supabase
    .from("prompt_versions")
    .insert({
      module,
      version: nextVersion,
      prompt: template,
      template_hash: hash,
      active: false,
      created_by: "auto-register",
      notes: "auto-registered from code at run start",
    })
    .select("id")
    .single();
  if (created) {
    const { error: ae } = await supabase
      .from("prompt_versions")
      .update({ active: true })
      .eq("id", created.id);
    if (!ae) {
      await supabase
        .from("prompt_versions")
        .update({ active: false })
        .eq("module", module)
        .neq("id", created.id);
    }
    return { id: created.id, hash };
  }

  // Insert unique violation: either the (module, template_hash) race (another
  // run registered this template first) or a (module, version) collision from
  // the non-atomic max(version)+1 read. Re-lookup by hash and use the winner's
  // row as-is — never touch other rows' active flags on this path.
  if (error) {
    const { data: raced } = await supabase
      .from("prompt_versions")
      .select("id")
      .eq("module", module)
      .eq("template_hash", hash)
      .maybeSingle();
    if (raced) return { id: raced.id, hash };
  }
  return { id: null, hash };
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

  const template = mod.templateText?.(opts.config);
  let promptVersionId: string | null = null;
  let hash: string | null = null;
  let renderTemplate: string | null = null;
  if (template !== undefined) {
    const resolved = await resolvePromptVersion(supabase, opts.module, template);
    promptVersionId = resolved.id;
    hash = resolved.hash;
    renderTemplate = template;
  } else {
    // No templateText — today's active-version lookup.
    const { data: pv } = await supabase
      .from("prompt_versions")
      .select("id, prompt")
      .eq("module", opts.module)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    promptVersionId = pv?.id ?? null;
    renderTemplate = pv?.prompt ?? null;
  }

  const prompt = mod.renderPrompt(renderTemplate, opts.config);

  // Drafting runs never attach contacts to their batch (output goes to
  // touches), so the sourcing-style eval gate has nothing to sample — its gate
  // lives at send review instead. Create the batch pre-passed so the Runs page
  // doesn't accumulate a permanent zero-contact 'open' batch per drafting run.
  const { data: batch, error: be } = await supabase
    .from("batches")
    .insert({
      module: opts.module,
      label: opts.label,
      ...(opts.module === "drafting" ? { gate_status: "passed" } : {}),
    })
    .select("id")
    .single();
  if (be || !batch) throw new Error(`Could not create batch: ${be?.message ?? "no row"}`);

  const { data: run, error: re } = await supabase
    .from("runs")
    .insert({
      module: opts.module,
      prompt_version_id: promptVersionId,
      batch_id: batch.id,
      executor: "copy_paste",
      provider_label: "copy-paste",
      config: opts.config,
      status: "awaiting_input",
      created_by: opts.createdBy ?? null,
      // Prompt honesty: what the operator actually pasted, plus the template
      // identity it was rendered from.
      rendered_prompt: prompt,
      template_hash: hash,
    })
    .select("id")
    .single();
  if (re || !run) throw new Error(`Could not create run: ${re?.message ?? "no row"}`);

  return { runId: run.id, batchId: batch.id, promptVersionId, prompt };
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
    .select("id, module, batch_id, prompt_version_id, config")
    .eq("id", opts.runId)
    .single();
  if (rerr || !run) {
    return { ok: false, error: `Run not found: ${rerr?.message ?? opts.runId}`, inserted: 0, rejected: 0, sampledCount: 0, messages: [] };
  }

  // Atomically claim the run before parsing: exactly one ingest wins the flip
  // to 'ingesting'. Re-ingest stays allowed from 'awaiting_input' and 'failed'
  // (the bad-paste retry), but a run that already ingested never double-writes
  // its batch on a double-click or replayed submit.
  const { data: claimed, error: cerr } = await supabase
    .from("runs")
    .update({ status: "ingesting", started_at: new Date().toISOString() })
    .eq("id", run.id)
    .in("status", ["awaiting_input", "failed"])
    .select("id");
  if (cerr) {
    return { ok: false, error: `Could not claim run: ${cerr.message}`, inserted: 0, rejected: 0, sampledCount: 0, messages: [] };
  }
  if (!claimed?.length) {
    return {
      ok: false,
      error: "This run already ingested its output — start a new run to import again.",
      inserted: 0,
      rejected: 0,
      sampledCount: 0,
      messages: [],
    };
  }

  const mod = getModule(run.module as ModuleKey);
  const requireEvidence = opts.requireEvidence ?? requiresEvidence(run.module as ModuleKey);
  const parsed = mod.parse(opts.rawText);
  if (!parsed.ok) {
    // Keep raw_io on failure too — the unparseable paste is the most
    // diagnostic output a failed run has.
    await supabase
      .from("runs")
      .update({
        status: "failed",
        error: parsed.error,
        finished_at: new Date().toISOString(),
        raw_io: { rawText: opts.rawText },
        require_evidence: requireEvidence,
      })
      .eq("id", run.id);
    return { ok: false, error: parsed.error, inserted: 0, rejected: 0, sampledCount: 0, messages: [] };
  }

  const { data: s } = await supabase
    .from("settings")
    .select("sample_rate")
    .eq("module", run.module)
    .maybeSingle();
  const sampleRate = s?.sample_rate ?? 1;

  const outcome = await mod.ingest(supabase, parsed.data, {
    runId: run.id,
    batchId: run.batch_id,
    promptVersionId: run.prompt_version_id ?? null,
    config: (run.config as Record<string, unknown>) ?? {},
    sampleRate,
    requireEvidence,
    createdBy: opts.createdBy ?? null,
  });

  await supabase
    .from("runs")
    .update({
      status: outcome.ok ? "review_ready" : "failed",
      error: outcome.ok ? null : outcome.error ?? null,
      finished_at: new Date().toISOString(),
      raw_io: { rawText: opts.rawText },
      // The ingest outcome outlives the toast: what went in, what was
      // rejected, under which evidence rule.
      require_evidence: requireEvidence,
      ingest_report: outcome,
    })
    .eq("id", run.id);

  return { ...outcome, batchId: run.batch_id };
}
