import { DraftsPayloadSchema, type DraftsPayload } from "../drafting/contracts";
import {
  buildDraftPrompt,
  buildDraftAgentPrompt,
  buildTemplateText,
  trackKindOf,
  type DraftContact,
  type TrackKind,
} from "../drafting/prompt";
import { storeDrafts } from "../drafting/import-core";
import type { RunModule, IngestOutcome } from "./types";

// Drafting as a pipeline module. Output is one or more drafted touches per
// contact; ingest writes them as planned outbound touches (storeDrafts). Drafting
// produces messages rather than records that carry source evidence, so it is not
// evidence-gated or sampled here — its gate is the 100% human send review: every
// draft lands unapproved and sends only after an explicit approval in the queue.

export type DraftingConfig = {
  contacts: DraftContact[];
  track?: TrackKind;
  // "single": one pasted batch; "agent": Claude Code fans chunks out to subagents.
  mode?: "single" | "agent";
  chunkSize?: number;
};

// Prefer the operator's explicit track; derive from the batch otherwise so a
// module-driven run of MSP contacts never gets the customer framing.
const trackOf = (config: DraftingConfig): TrackKind =>
  config.track ?? trackKindOf(config.contacts ?? []);

// Hooks ride the config's contact rows (the Draft page resolves each contact's
// usable hook server-side). Ingest threads the contact→hook map into
// storeDrafts so every stored touch is stamped with the hook it consumed —
// touches.hook_id is the usage record; hooks.status is never flipped here.
const hookIdsOf = (config: DraftingConfig): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const c of config.contacts ?? []) {
    if (c.hook_id) map[c.contact_id] = c.hook_id;
  }
  return map;
};

export const draftingModule: RunModule<DraftingConfig, DraftsPayload> = {
  key: "drafting",
  label: "drafted messages",

  renderPrompt(_template, config) {
    const contacts = config.contacts ?? [];
    const kind = trackOf(config);
    return config.mode === "agent"
      ? buildDraftAgentPrompt(contacts, config.chunkSize ?? 15, kind)
      : buildDraftPrompt(contacts, kind);
  },

  // The static per-track rules text ({{contacts}} placeholder) — what the run
  // lifecycle hashes to version the prompt independent of the pasted batch.
  templateText(config) {
    return buildTemplateText(trackOf(config));
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

  async ingest(supabase, output, ctx): Promise<IngestOutcome> {
    const config = (ctx.config ?? {}) as DraftingConfig;
    const report = await storeDrafts(
      supabase,
      output.drafts,
      {
        runId: ctx.runId,
        promptVersionId: ctx.promptVersionId ?? null,
        track: trackOf(config),
      },
      hookIdsOf(config),
    );
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
