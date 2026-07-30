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
import { exampleLeakDetector, describeLeaks } from "../drafting/example-leak";
import { learnedRuleBlock } from "../learning/rules";
import { workspaceProfile } from "../workspace/profile";
import { senderOverridesFor, applySenderOverrides } from "../workspace/sender";
import { DEFAULT_PROFILE, type WorkspaceProfile } from "../workspace/identity";
import type { RunModule, IngestOutcome } from "./types";

// Drafting as a pipeline module. Output is one or more drafted touches per
// contact; ingest writes them as planned outbound touches (storeDrafts). Drafting
// produces messages rather than records that carry source evidence, so it is not
// evidence-gated or sampled here — its gate is the 100% human send review: every
// draft lands unapproved and sends only after an explicit approval in the queue.

export type DraftingConfig = {
  contacts: DraftContact[];
  /** The run this drafting session was scoped to (the Draft page's ?run=
   *  filter), when it was exactly one. The Runs timeline nests the drafting
   *  entry inside that run's card; unscoped sessions span several runs and
   *  stay top-level. Recorded at start — a run's config is its own record of
   *  what it was asked to do. */
  sourceRunId?: string | null;
  track?: TrackKind;
  // "single": one pasted batch; "agent": Claude Code fans chunks out to subagents.
  mode?: "single" | "agent";
  chunkSize?: number;
  /** Rendered block of rules learned from human edits (migration 025). Loaded
   *  in prepareConfig so it is part of the hashed template, which is what makes
   *  a rule change a new prompt_version and therefore measurable. */
  learnedRules?: string;
  /** The workspace's firm identity and market vocabulary (migration 032),
   *  loaded in prepareConfig for the same reason: renaming the firm or the
   *  market changes the prompt, so it must change the version too. */
  profile?: WorkspaceProfile;
};

const profileOf = (config: DraftingConfig): WorkspaceProfile =>
  config.profile ?? DEFAULT_PROFILE;

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

  // Learned rules are read here, before the prompt is built or hashed, so the
  // template, its hash, and the persisted config all describe the same run.
  async prepareConfig(supabase, config, ctx) {
    const kind = trackOf(config);
    const base = await workspaceProfile(supabase, ctx.workspaceId);
    // The sender is the run's creator, not the firm: overlay their sign-off name
    // and intro over the workspace default (migration 045). This makes senderName
    // part of the hashed template, so a per-user sender is a per-user prompt
    // version — intentional, and how outcomes stay attributable per author.
    const overrides = await senderOverridesFor(supabase, ctx.workspaceId, ctx.userId ?? null);
    const profile = applySenderOverrides(base, overrides);
    const { block, rules } = await learnedRuleBlock(supabase, "drafting", ctx.workspaceId, {
      track: kind,
    });
    const prepared = { ...config, profile, ...(block ? { learnedRules: block } : {}) };
    const notes = block
      ? [`Prompt carries ${rules.length} rule(s) learned from your edits to earlier drafts.`]
      : [];
    return { config: prepared, notes };
  },

  renderPrompt(_template, config) {
    const contacts = config.contacts ?? [];
    const kind = trackOf(config);
    const learned = config.learnedRules ?? "";
    const profile = profileOf(config);
    return config.mode === "agent"
      ? buildDraftAgentPrompt(contacts, config.chunkSize ?? 15, kind, learned, profile)
      : buildDraftPrompt(contacts, kind, learned, profile);
  },

  // The static per-track rules text ({{contacts}} placeholder) — what the run
  // lifecycle hashes to version the prompt independent of the pasted batch.
  templateText(config) {
    return buildTemplateText(trackOf(config), config.learnedRules ?? "", profileOf(config));
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

    // Advisory only: did any draft borrow the worked example's market substance
    // rather than imitating its voice? Reported, never rejected — a false
    // positive that binned a good draft would cost more than the thing it
    // guards against, and every draft is human-reviewed before it sends anyway.
    const byId = new Map((config.contacts ?? []).map((c) => [c.contact_id, c]));
    // Built once for the whole batch — the example and its baseline do not vary
    // per draft.
    const detectLeaks = exampleLeakDetector(profileOf(config), trackOf(config));
    const leakNotes: string[] = [];
    for (const d of output.drafts) {
      const c = byId.get(d.contact_id);
      if (!c) continue;
      // Everything legitimately known about this recipient. A draft that says
      // "pediatric practice" to an actual pediatric practice is not borrowing.
      const context = [
        c.company_name,
        c.title,
        c.city,
        c.current_msp,
        c.hook_text,
        c.fallback_angle,
      ]
        .filter(Boolean)
        .join(" ");
      const note = describeLeaks(detectLeaks(d.body, context));
      if (note) leakNotes.push(`${c.full_name ?? d.contact_id}: ${note}`);
    }

    const report = await storeDrafts(
      supabase,
      output.drafts,
      {
        runId: ctx.runId,
        promptVersionId: ctx.promptVersionId ?? null,
        track: trackOf(config),
        createdBy: ctx.createdBy ?? null,
      },
      hookIdsOf(config),
      ctx.workspaceId,
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
        ...leakNotes,
      ],
    };
  },
};
