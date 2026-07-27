import type { SupabaseClient } from "@supabase/supabase-js";
import { SourcingPayloadSchema, type SourcingPayload } from "../contracts";
import {
  buildPrompt,
  buildTemplateText,
  KNOWN_LIMIT,
  type KnownOrg,
  type PromptParams,
} from "../sourcing/prompts";
import { importPayload } from "../sourcing/import-core";
import type { ImportKind } from "../sourcing/types";
import { learnedRuleBlock } from "../learning/rules";
import type { RunModule, IngestContext, IngestOutcome } from "./types";

// Sourcing as a pipeline module. renderPrompt delegates to the existing
// buildPrompt (the active prompt_version text is the versioned provenance
// snapshot stamped on the run). ingest delegates to importPayload, now wired for
// batch tagging, deterministic sampling, and evidence-required rejection.

export type SourcingConfig = PromptParams & {
  kind: ImportKind;
  targetMspId?: string | null;
};

// KNOWN_LIMIT lives in ../sourcing/prompts so the Source page can surface it.
// Truncation is stated in the prompt and is only ever a cost (some duplicate
// research), never a correctness problem — import-core's domain/name matching
// remains the backstop that keeps duplicates out of the database.

// Read the companies previous runs already sourced, scoped to what this run is
// actually researching:
//   research_msps        → MSPs we hold (a re-run should surface NEW targets)
//   research_customers   → customers we hold
//   find_customers_for_msps → only the known clients OF the selected MSPs, since
//                             the same company under a different MSP is a real
//                             find, not a duplicate
async function loadKnownOrgs(
  supabase: SupabaseClient,
  config: SourcingConfig,
): Promise<{ known: KnownOrg[]; omitted: number }> {
  const empty = { known: [], omitted: 0 };

  if (config.mode === "find_customers_for_msps") {
    const mspIds = (config.msps ?? []).map((m) => m.id).filter(Boolean) as string[];
    // MSPs typed in free-text have no id, so we can't scope their known clients;
    // the ones picked from the list do.
    if (!mspIds.length) return empty;
    const nameById = new Map(
      (config.msps ?? []).filter((m) => m.id).map((m) => [m.id as string, m.name]),
    );
    const { data, count } = await supabase
      .from("organizations")
      .select("name, domain, current_msp_id", { count: "exact" })
      .eq("kind", "customer")
      .in("current_msp_id", mspIds)
      .order("name")
      .range(0, KNOWN_LIMIT - 1);
    const known = (data ?? []).map((o) => ({
      name: o.name as string,
      domain: (o.domain as string | null) ?? null,
      mspName: nameById.get(o.current_msp_id as string) ?? null,
    }));
    return { known, omitted: Math.max(0, (count ?? known.length) - known.length) };
  }

  const kind = config.mode === "research_msps" ? "msp" : "customer";
  const { data, count } = await supabase
    .from("organizations")
    .select("name, domain", { count: "exact" })
    .eq("kind", kind)
    .order("name")
    .range(0, KNOWN_LIMIT - 1);
  const known = (data ?? []).map((o) => ({
    name: o.name as string,
    domain: (o.domain as string | null) ?? null,
  }));
  return { known, omitted: Math.max(0, (count ?? known.length) - known.length) };
}

export const sourcingModule: RunModule<SourcingConfig, SourcingPayload> = {
  key: "sourcing",
  label: "customers & contacts",

  // Make each run aware of every earlier one: the companies already in the
  // database go into the prompt as a do-not-research list. Ingest has always
  // deduped these on the way in, so re-runs never corrupted the data — they
  // just spent the whole research budget rediscovering rows that were then
  // thrown away as duplicates. Excluding them up front is what turns a repeat
  // run into new coverage.
  //
  // The runner executor gets no list at all. It can call POST /api/sourcing/known
  // mid-run and check candidates against the *entire* database, so embedding a
  // KNOWN_LIMIT-capped snapshot would be strictly worse: redundant, and capped
  // where the API is not. The cap only exists because a pasted prompt is a
  // one-shot artifact that cannot ask a follow-up question.
  async prepareConfig(supabase, config, ctx) {
    // Rules learned from graded mistakes and review deletions ride every
    // sourcing prompt, on both executors.
    const learned = await learnedRuleBlock(supabase, "sourcing");
    const withRules = learned.block
      ? { ...config, learnedRules: learned.block }
      : config;
    const learnedNote = learned.rules.length
      ? [`Prompt carries ${learned.rules.length} rule(s) learned from your corrections.`]
      : [];

    if (ctx.executor === "runner") {
      return {
        config: { ...withRules, checkKnownViaApi: true },
        notes: [
          "Runner run: candidates are checked against the full database via POST /api/sourcing/known, so no exclusion list is embedded and no cap applies.",
          ...learnedNote,
        ],
      };
    }
    const { known, omitted } = await loadKnownOrgs(supabase, config);
    if (!known.length) return { config: withRules, notes: learnedNote };
    const label =
      config.mode === "research_msps"
        ? `${known.length} MSP${known.length === 1 ? "" : "s"}`
        : `${known.length} compan${known.length === 1 ? "y" : "ies"}`;
    return {
      config: { ...withRules, known, knownOmitted: omitted },
      notes: [
        `Prompt excludes ${label} already sourced${
          config.mode === "find_customers_for_msps" ? " for the selected MSP(s)" : ""
        }${omitted ? `, plus ${omitted} more listed only as a count` : ""}.`,
        ...learnedNote,
      ],
    };
  },

  renderPrompt(_template, config) {
    return buildPrompt(config);
  },

  templateText(config) {
    return buildTemplateText(config);
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
      workspaceId: ctx.workspaceId,
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
