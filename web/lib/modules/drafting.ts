import { DraftsPayloadSchema, type DraftsPayload } from "../drafting/contracts";
import { buildDraftPrompt, type DraftContact } from "../drafting/prompt";
import { storeDrafts } from "../drafting/import-core";
import type { RunModule, IngestOutcome } from "./types";

// Drafting as a pipeline module. Output is one or more drafted touches per
// contact; ingest writes them as planned outbound touches (storeDrafts). Drafting
// produces messages rather than records that carry source evidence, so it is not
// evidence-gated or sampled here — its quality is graded on the touch text in the
// review queue (P3).

export type DraftingConfig = {
  contacts: DraftContact[];
};

export const draftingModule: RunModule<DraftingConfig, DraftsPayload> = {
  key: "drafting",
  label: "drafted messages",

  renderPrompt(_template, config) {
    return buildDraftPrompt(config.contacts ?? []);
  },

  parse(rawText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: "That is not valid JSON. Paste the full JSON object the model returned." };
    }
    const result = DraftsPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, error: `Validation failed — ${issues.join("; ")}` };
    }
    return { ok: true, data: result.data };
  },

  async ingest(supabase, output): Promise<IngestOutcome> {
    const report = await storeDrafts(supabase, output.drafts);
    return {
      ok: report.ok,
      error: report.error,
      inserted: report.drafted + report.updated,
      rejected: 0,
      sampledCount: 0,
      messages: [
        `${report.drafted} draft(s) written, ${report.updated} updated; ${report.skippedNoAddress} skipped (no address), ${report.skippedUnknown} unknown contact.`,
        ...report.messages,
      ],
    };
  },
};
