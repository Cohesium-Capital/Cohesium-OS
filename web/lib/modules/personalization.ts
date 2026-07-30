import { z } from "zod";
import { isSampled } from "../grading/math";
import { learnedRuleBlock } from "../learning/rules";
import { workspaceProfile } from "../workspace/profile";
import { DEFAULT_PROFILE, type WorkspaceProfile, type WorkspaceVocab } from "../workspace/identity";
import type { RunModule, IngestContext, IngestOutcome } from "./types";

// Personalization as a pipeline module: research ONE durable, verifiable hook
// per contact — {claim, source_url, published date, kind} — checkable by a
// human in ~30s. Rows land in the hooks table (never on contacts), sampled for
// verification before drafting consumes them; touches.hook_id ties each sent
// message back to the hook it used. kind='none' with an honest fallback_angle
// is a first-class, NON-ERROR outcome: scoring "no hook" as failure would
// incentivize invention, the exact honesty violation the firm bans.

const HOOK_KINDS = [
  "talk",
  "news",
  "post",
  "award",
  "role_change",
  "company_news",
  "other",
  "none",
] as const;

const optStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().nullish(),
);

// Fail-soft on a malformed date rather than sinking the whole paste: the
// source_url is the evidence, the date only feeds the 12-month recency filter,
// and verification sampling catches stale claims anyway. Round-trip through
// Date so calendar-invalid strings ("2025-02-30" passes the regex but
// normalizes to a different day) fall to null instead of poisoning the insert.
const optDate = z.preprocess((v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}, z.string().nullish());

export const HooksPayloadSchema = z.object({
  hooks: z
    .array(
      z
        .object({
          contact_id: z.string().min(1, "contact_id required"),
          // Fail-soft: an unknown kind becomes 'other' (still evidence-gated
          // below) instead of failing the paste.
          kind: z.enum(HOOK_KINDS).catch("other"),
          hook: optStr,
          source_url: optStr,
          published_at: optDate,
          fallback_angle: optStr,
        })
        .superRefine((row, ctx) => {
          // The evidence rule applies only to real hooks, never to the honest
          // no-hook outcome — that asymmetry is the contract.
          if (row.kind !== "none") {
            if (!row.hook) {
              ctx.addIssue({
                code: "custom",
                path: ["hook"],
                message: `hook required when kind is "${row.kind}"`,
              });
            }
            if (!row.source_url) {
              ctx.addIssue({
                code: "custom",
                path: ["source_url"],
                message: `source_url required when kind is "${row.kind}" — no evidence, no hook`,
              });
            }
          } else if (!row.fallback_angle) {
            ctx.addIssue({
              code: "custom",
              path: ["fallback_angle"],
              message: `fallback_angle required when kind is "none"`,
            });
          }
        }),
    )
    .min(1, "no hooks"),
});

export type HooksPayload = z.infer<typeof HooksPayloadSchema>;

export type PersonalizationContact = {
  contact_id: string;
  full_name: string | null;
  title: string | null;
  company_name: string;
  company_domain: string | null;
  current_msp: string | null;
};

export type PersonalizationConfig = {
  contacts: PersonalizationContact[];
  /** stamped onto hooks rows so hook_outcomes can split by pipeline track */
  track?: "msp" | "customer";
  /** Rules learned from rejected hooks (migration 025). */
  learnedRules?: string;
  /**
   * The workspace's identity and market vocabulary (migration 032), loaded in
   * prepareConfig for the same reason drafting loads it there: the vocabulary is
   * part of the prompt, so changing the market must change the version too.
   *
   * This module went without one until now, which meant hook research was the
   * only stage that could not speak a tenant's market — it asked every workspace
   * for hooks that were not "they provide IT services".
   */
  profile?: WorkspaceProfile;
};

// The static instruction portion; the contact lines are the volatile config and
// become {{contacts}}. Hashed by createRun for mechanical prompt versioning.
//
// A function of the vocabulary rather than a constant, so the one market-specific
// line in it (the example of a detail too generic to be a hook) names the
// tenant's own market. With DEFAULT_VOCAB it renders exactly the string it was
// before, so Cohesium's prompt_version does not fork.
const templateFor = (v: WorkspaceVocab) => [
  `For EACH person below, research ONE true, specific, verifiable hook to open a warm outreach with — a recent talk or panel, news mention, post, award, role change, or company announcement. Strongly prefer something from the LAST 12 MONTHS.`,
  ``,
  `Rules:`,
  `- VERIFY every hook with web search before you submit it. Only state a claim a human could confirm in ~30 seconds by opening your source_url.`,
  `- Every real hook needs a "source_url" that supports THAT specific claim, a "published_at" date (YYYY-MM-DD; null if the page shows no date), and the best-fit "kind".`,
  `- SPECIFIC beats generic: a detail true of any company in the space ("they have a website", "they provide ${v.customerFunction} services") is NOT a hook. If that is all you can find, it is a "none".`,
  `- If you cannot verify anything specific, return kind "none" with hook/source_url/published_at null and an honest "fallback_angle": one or two sentences of neutral, true observation about their role or industry to open with instead.`,
  `- An honest "none" is a GOOD outcome and counts as a fully completed contact. Inventing or embellishing a detail is the WORST possible outcome — every hook is spot-checked against its source before drafting.`,
  `- The "hook" is the claim itself in one or two sentences, not a full email. Use the exact contact_id from each line.`,
  ``,
  `Return ONLY this JSON: { "hooks": [ { "contact_id": string, "kind": "talk"|"news"|"post"|"award"|"role_change"|"company_news"|"other"|"none", "hook": string|null, "source_url": string|null, "published_at": "YYYY-MM-DD"|null, "fallback_angle": string|null } ] }`,
  ``,
  `Contacts:`,
  `{{contacts}}`,
].join("\n");

// Mirrors drafting's profileOf: a config that predates the profile field (an old
// run replayed from its stored config) falls back to the code default rather
// than crashing, and the default is Cohesium's exact prior wording.
const profileOf = (config: PersonalizationConfig): WorkspaceProfile =>
  config.profile ?? DEFAULT_PROFILE;

export const personalizationModule: RunModule<PersonalizationConfig, HooksPayload> = {
  key: "personalization",
  label: "personalization hooks",

  renderPrompt(_template, config) {
    const vocab = profileOf(config).vocab;
    const lines = (config.contacts ?? []).map((c, i) => {
      const company = c.company_domain ? `${c.company_name} (${c.company_domain})` : c.company_name;
      const parts = [
        `[${i + 1}] contact_id=${c.contact_id}`,
        `name=${c.full_name ?? "unknown"}`,
        c.title ? `title=${c.title}` : "",
        `company=${company}`,
        c.current_msp ? `current_msp=${c.current_msp}` : "",
      ].filter(Boolean);
      return parts.join("; ");
    });
    // Function replacement so contact data is inserted literally ($ not special).
    const rendered = templateFor(vocab).replace("{{contacts}}", () => lines.join("\n"));
    return config.learnedRules ? `${rendered}\n\n${config.learnedRules}` : rendered;
  },

  // Learned rules append to the template, so a rule change re-hashes into a
  // new prompt_version exactly like an edit to the template itself would.
  async prepareConfig(supabase, config, ctx) {
    // The profile is loaded unconditionally, unlike the learned-rule block: a
    // workspace always has a vocabulary (its own or the code default), and the
    // prompt cannot be rendered honestly without it.
    const profile = await workspaceProfile(supabase, ctx.workspaceId);
    const { block, rules } = await learnedRuleBlock(
      supabase,
      "personalization",
      ctx.workspaceId,
    );
    return {
      config: { ...config, profile, ...(block ? { learnedRules: block } : {}) },
      notes: block
        ? [`Prompt carries ${rules.length} rule(s) learned from rejected hooks.`]
        : [],
    };
  },

  templateText(config) {
    const template = templateFor(profileOf(config).vocab);
    return config.learnedRules ? `${template}\n\n${config.learnedRules}` : template;
  },

  parse(rawText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: "That is not valid JSON. Paste the full JSON object the model returned." };
    }
    const result = HooksPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, error: `Validation failed — ${issues.join("; ")}` };
    }
    return { ok: true, data: result.data };
  },

  async ingest(supabase, output, ctx: IngestContext): Promise<IngestOutcome> {
    const messages: string[] = [];
    // rejected_ingest is a root table (its run_id is nullable, so it cannot
    // inherit), which means every reject carries the run's workspace itself.
    const rejects: {
      workspace_id: string;
      run_id: string | null;
      payload: unknown;
      reason: string;
    }[] = [];

    // Evidence gate — defense in depth behind parse(): a real hook without a
    // source_url violates the contract regardless of ctx.requireEvidence.
    // kind='none' rows are always valid; the gate never applies to them.
    let rejected = 0;
    const candidates: HooksPayload["hooks"] = [];
    for (const h of output.hooks) {
      if (h.kind !== "none" && !(h.source_url && h.source_url.trim())) {
        rejected++;
        rejects.push({ workspace_id: ctx.workspaceId, run_id: ctx.runId, payload: h, reason: "hook has no source_url (evidence)" });
        continue;
      }
      candidates.push(h);
    }

    // One hook per contact per paste: models sometimes emit the same contact
    // twice. Prefer a real-kind row over an honest 'none' when both exist,
    // else first occurrence wins; discards are logged, never silently eaten.
    let duplicates = 0;
    const byContact = new Map<string, HooksPayload["hooks"][number]>();
    for (const h of candidates) {
      const seen = byContact.get(h.contact_id);
      if (!seen) {
        byContact.set(h.contact_id, h);
        continue;
      }
      duplicates++;
      const discarded = seen.kind === "none" && h.kind !== "none" ? seen : h;
      if (discarded === seen) byContact.set(h.contact_id, h);
      rejects.push({ workspace_id: ctx.workspaceId, run_id: ctx.runId, payload: discarded, reason: "duplicate contact_id in paste" });
    }
    const deduped = [...byContact.values()];
    if (duplicates) messages.push(`${duplicates} duplicate contact_id row(s) in paste discarded`);

    // Resolve contact_ids in one read; soft-deleted contacts don't take hooks.
    const ids = [...new Set(deduped.map((h) => h.contact_id))];
    const known = new Set<string>();
    if (ids.length) {
      const { data: found, error: lookupError } = await supabase
        .from("contacts")
        .select("id")
        .in("id", ids)
        .is("deleted_at", null);
      if (lookupError) {
        if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
        return {
          ok: false,
          error: `contact lookup failed: ${lookupError.message}`,
          inserted: 0,
          rejected,
          sampledCount: 0,
          messages,
        };
      }
      for (const row of found ?? []) known.add(row.id as string);
    }

    const track = ctx.config?.track === "msp" || ctx.config?.track === "customer"
      ? (ctx.config.track as "msp" | "customer")
      : null;

    let unknown = 0;
    let sampledCount = 0;
    let noneCount = 0;
    const rows: Record<string, unknown>[] = [];
    for (const h of deduped) {
      if (!known.has(h.contact_id)) {
        unknown++;
        messages.push(`unknown contact_id ${h.contact_id}`);
        continue;
      }
      const isNone = h.kind === "none";
      if (isNone) noneCount++;
      const sampled = isSampled(h.contact_id, ctx.sampleRate);
      if (sampled) sampledCount++;
      rows.push({
        contact_id: h.contact_id,
      workspace_id: ctx.workspaceId,
        text: isNone ? null : h.hook,
        source_url: h.source_url?.trim() || null,
        source_published_at: h.published_at ?? null,
        kind: h.kind,
        fallback_angle: h.fallback_angle ?? null,
        track,
        run_id: ctx.runId,
        prompt_version_id: ctx.promptVersionId ?? null,
        batch_id: ctx.batchId,
        sampled,
        // status stays at its 'candidate' default; 'used' is never written —
        // usage is derived from touches.hook_id.
      });
    }

    // Zero rows is a failed import, not a quiet success — say why so the
    // operator can fix the paste instead of wondering where the hooks went.
    if (rows.length === 0) {
      const why = [
        rejected ? `${rejected} dropped for missing evidence` : null,
        unknown ? `${unknown} unknown contact(s)` : null,
        duplicates ? `${duplicates} duplicate(s) discarded` : null,
      ]
        .filter(Boolean)
        .join("; ");
      if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
      return {
        ok: false,
        error: `No hooks imported — ${why || "every row was rejected"}.`,
        inserted: 0,
        rejected,
        sampledCount: 0,
        messages,
      };
    }

    // A non-empty batch must always produce at least one verify card, or its
    // gate can never decide — force-sample the first row when the hash picked none.
    if (sampledCount === 0) {
      rows[0].sampled = true;
      sampledCount = 1;
    }

    const { error: insertError } = await supabase.from("hooks").insert(rows);
    if (insertError) {
      if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
      return {
        ok: false,
        error: `insert hooks failed: ${insertError.message}`,
        inserted: 0,
        rejected,
        sampledCount: 0,
        messages,
      };
    }
    const inserted = rows.length;

    if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
    return {
      ok: true,
      inserted,
      rejected,
      sampledCount,
      messages: [
        `${inserted} hook(s) written (${noneCount} honest no-hook)` +
          `; ${rejected} dropped for missing evidence` +
          (unknown ? `; ${unknown} unknown contact(s) skipped` : "") +
          `.`,
        ...messages,
      ],
    };
  },
};
