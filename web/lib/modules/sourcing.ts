import { SourcingPayloadSchema, type SourcingPayload } from "../contracts";
import { buildPrompt, type PromptParams } from "../sourcing/prompts";
import { importPayload } from "../sourcing/import-core";
import type { ImportKind } from "../sourcing/types";
import type { RunModule, IngestContext, IngestOutcome } from "./types";

// Sourcing as a pipeline module. renderPrompt delegates to the existing
// buildPrompt (the active prompt_version text is the versioned provenance
// snapshot stamped on the run). ingest delegates to importPayload, now wired for
// batch tagging, deterministic sampling, and evidence-required rejection.

export type SourcingConfig = PromptParams & {
  kind: ImportKind;
  targetMspId?: string | null;
};

export const sourcingModule: RunModule<SourcingConfig, SourcingPayload> = {
  key: "sourcing",
  label: "customers & contacts",

  renderPrompt(_template, config) {
    return buildPrompt(config);
  },

  parse(rawText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: "That is not valid JSON. Paste the full JSON object the model returned." };
    }
    const result = SourcingPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, error: `Validation failed — ${issues.join("; ")}` };
    }
    return { ok: true, data: result.data };
  },

  async ingest(supabase, output, ctx: IngestContext): Promise<IngestOutcome> {
    const kind = (ctx.config.kind as ImportKind) ?? "customer";
    const targetMspId = (ctx.config.targetMspId as string | null) ?? null;
    const report = await importPayload(supabase, {
      rawText: JSON.stringify(output),
      kind,
      targetMspId,
      createdBy: ctx.createdBy ?? null,
      batchId: ctx.batchId,
      runId: ctx.runId,
      sampleRate: ctx.sampleRate,
      requireEvidence: ctx.requireEvidence,
    });
    return {
      ok: report.ok,
      error: report.error,
      inserted: report.inserted.contacts,
      rejected: report.rejected,
      sampledCount: report.sampledCount,
      messages: [
        `${report.inserted.organizations} org(s), ${report.inserted.contacts} contact(s) inserted; ${report.merged} merged; ${report.skippedDuplicates} dup(s) skipped.`,
        ...report.messages,
      ],
    };
  },
};
