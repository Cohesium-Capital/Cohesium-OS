import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  markProcessed,
  unprocessedSignals,
  type LearningModule,
  type LearningSignal,
} from "./signals";
import {
  activeRules,
  AUTO_ACTIVATE_CONFIDENCE,
  AUTO_ACTIVATE_SUPPORT,
  MAX_ACTIVE_RULES,
  type PromptRule,
} from "./rules";
import { healthFor } from "./health";
import { evidenceIsIndependent } from "./sessions";

// The analyzer: read a batch of human corrections, propose prompt rules.
//
// This is the only place in the pipeline that spends the metered API rather
// than the operator's subscription — deliberately, because it is small (a few
// dozen short diffs, a few times a week) and because it is the one job that
// cannot be a copy-paste step: nobody is going to paste their own edit history
// into a chat window every night.
//
// The model proposes; it does not decide. Activation is gated on evidence
// count in code below, every rule keeps its receipts, and a human can retire
// any of them from Settings.

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16_000;

// Enough signals to see a pattern, few enough to keep one call cheap.
const BATCH = 60;

// A rule earns its place by being followed. Long, hedged, or compound rules get
// skimmed — the cap is a quality constraint, not a token one.
const MAX_RULE_CHARS = 220;

const ProposalSchema = z.object({
  rule_text: z.string().min(8).max(MAX_RULE_CHARS),
  rationale: z.string().max(400),
  scope: z.object({
    channel: z.enum(["email", "linkedin", "any"]).nullable(),
    track: z.enum(["customer", "msp", "any"]).nullable(),
    field: z.string().nullable(),
  }),
  evidence_signal_ids: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  supersedes_rule_id: z.string().nullable(),
});

const ResultSchema = z.object({
  proposals: z.array(ProposalSchema),
  notes: z.string(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

// Hand-written rather than generated: structured outputs reject several JSON
// Schema keywords zod emits (minLength/maxLength among them), and the explicit
// shape is what the model actually reads.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals", "notes"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rule_text",
          "rationale",
          "scope",
          "evidence_signal_ids",
          "confidence",
          "supersedes_rule_id",
        ],
        properties: {
          rule_text: {
            type: "string",
            description: `One imperative sentence the writer can follow, under ${MAX_RULE_CHARS} characters. No hedging, no rationale inside it.`,
          },
          rationale: {
            type: "string",
            description: "Why the evidence supports this rule. Shown to a human reviewer.",
          },
          scope: {
            type: "object",
            additionalProperties: false,
            required: ["channel", "track", "field"],
            properties: {
              channel: { type: ["string", "null"], enum: ["email", "linkedin", "any", null] },
              track: { type: ["string", "null"], enum: ["customer", "msp", "any", null] },
              field: { type: ["string", "null"] },
            },
          },
          evidence_signal_ids: {
            type: "array",
            items: { type: "string" },
            description: "The signal ids this rule is drawn from. Only ids from the input.",
          },
          confidence: { type: "number" },
          supersedes_rule_id: {
            type: ["string", "null"],
            description: "Id of an existing active rule this replaces, or null.",
          },
        },
      },
    },
    notes: { type: "string" },
  },
} as const;

const SYSTEM = `You improve the prompts of an outbound research pipeline by reading what humans
corrected in its output.

You are given (1) the rules already active for one stage and (2) a batch of real
human corrections: edits to drafted messages, rejected research hooks, graded
mistakes on sourced records, deletions with reasons.

Propose prompt rules ONLY for patterns the evidence actually shows. Your bar:

- A pattern needs at least two independent corrections pointing the same way.
  One person changing one word is noise. Do not propose a rule for it.
- Write each rule as one imperative sentence a writer can follow, and be
  specific about the behavior. "Open with the recipient's own words where the
  hook provides them" is followable. "Improve the tone" is not.
- Describe what TO do wherever possible. A rule phrased only as a prohibition
  tells the writer what to avoid without telling them what to write instead.
- Never propose a rule that contradicts an active rule. If the evidence says an
  active rule is wrong, propose the replacement and set supersedes_rule_id.
- Never restate a rule that is already active in different words.
- Do not propose rules about the output format, the JSON contract, or anything
  structural. Those are owned by the code, not by you.
- If a correction looks like one person's stylistic preference rather than a
  repeated pattern, leave it alone and say so in notes.

Returning zero proposals is the correct answer when the evidence is thin. An
empty list is a good outcome, not a failed run.`;

const STRATEGY_SYSTEM = `A stage of this pipeline is failing: a large share of everything it produces is
being rejected by a human. You are given its current approach, the rules already
appended to it, and the corrections and rejections themselves.

Do NOT propose another incremental rule. The evidence says the approach itself
is not working, and one more bullet on a failing prompt does not fix it.

Propose at most TWO candidate strategies. A strategy is a short replacement for
HOW the stage does its job — where it looks, what it treats as qualifying, what
order it works in, what it refuses to guess at. Each one must:

- be concrete enough that a reader could follow it instead of the current
  approach, not a sentiment like "be more careful"
- name what it changes about the current approach and why the rejections
  suggest it
- be genuinely different from the other candidate, so the two are worth
  comparing rather than two phrasings of one idea
- stay inside the stage's job. Do not propose changing the output format, the
  contract, or what the pipeline does with the results.

These are experiments, not fixes. Each will run against the current approach and
be judged on whether the rejection rate actually falls, so propose things that
would produce a visibly different result rather than a safe restatement.`;

function renderSignals(signals: (LearningSignal & { id: string })[]): string {
  return signals
    .map((s) => {
      const scope = Object.entries(s.scope ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const lines = [`[${s.id}] ${s.kind}${scope ? ` (${scope})` : ""}`];
      if (s.category) lines.push(`  category: ${s.category}`);
      if (s.before_text) lines.push(`  before: ${s.before_text}`);
      if (s.after_text) lines.push(`  after:  ${s.after_text}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderActive(rules: PromptRule[]): string {
  if (!rules.length) return "(none yet)";
  return rules.map((r) => `[${r.id}] ${r.rule_text}`).join("\n");
}

export type AnalyzeResult = {
  module: LearningModule;
  signalsConsidered: number;
  proposed: number;
  autoActivated: number;
  skipped?: string;
  error?: string;
};

/**
 * One analyzer pass for one module. Safe to call when nothing has changed:
 * with too few unprocessed signals it returns early without spending anything.
 */
export async function analyzeModule(
  supabase: SupabaseClient,
  module: LearningModule,
  opts: { trigger?: "cron" | "manual"; minSignals?: number } = {},
): Promise<AnalyzeResult> {
  const trigger = opts.trigger ?? "cron";
  const minSignals = opts.minSignals ?? 4;

  const signals = await unprocessedSignals(supabase, module, BATCH);
  if (signals.length < minSignals) {
    return {
      module,
      signalsConsidered: signals.length,
      proposed: 0,
      autoActivated: 0,
      skipped: `only ${signals.length} new correction(s); waiting for at least ${minSignals}`,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      module,
      signalsConsidered: signals.length,
      proposed: 0,
      autoActivated: 0,
      skipped: "ANTHROPIC_API_KEY is not set — signals are being collected but not analyzed",
    };
  }

  const existing = await activeRules(supabase, module);
  const health = await healthFor(supabase, module);
  // A failing stage gets a replacement approach instead of another bullet.
  const strategyMode = Boolean(health?.needs_new_strategy);
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `Stage: ${module}`,
    health
      ? `Current rejection rate: ${Math.round((health.reject_rate ?? 0) * 100)}% (${health.rejected} of ${health.judged} judged)`
      : "",
    "",
    strategyMode
      ? "The approach currently in use (appended to the stage's prompt):"
      : "Rules already active for this stage:",
    renderActive(existing),
    "",
    `Human corrections (${signals.length}):`,
    renderSignals(signals),
  ]
    .filter(Boolean)
    .join("\n");

  let raw: string;
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: strategyMode ? STRATEGY_SYSTEM : SYSTEM,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: "user", content: userPrompt }],
    });

    // A refusal is a successful HTTP response with no usable content — check it
    // before reading content, or the parse below fails with a confusing error.
    if (response.stop_reason === "refusal") {
      await recordRun(supabase, {
        module,
        signals_considered: signals.length,
        proposed: 0,
        auto_activated: 0,
        model: MODEL,
        error: "analysis refused by safety classifiers",
        trigger,
      });
      return {
        module,
        signalsConsidered: signals.length,
        proposed: 0,
        autoActivated: 0,
        error: "analysis refused",
      };
    }

    usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    await recordRun(supabase, {
      module,
      signals_considered: signals.length,
      proposed: 0,
      auto_activated: 0,
      model: MODEL,
      error: message,
      trigger,
    });
    return { module, signalsConsidered: signals.length, proposed: 0, autoActivated: 0, error: message };
  }

  const parsed = ResultSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    const message = `analyzer returned unusable output: ${parsed.error.issues[0]?.message ?? "parse failed"}`;
    await recordRun(supabase, {
      module,
      signals_considered: signals.length,
      proposed: 0,
      auto_activated: 0,
      model: MODEL,
      error: message,
      trigger,
      ...usage,
    });
    return { module, signalsConsidered: signals.length, proposed: 0, autoActivated: 0, error: message };
  }

  const validIds = new Set(signals.map((s) => s.id));
  const byId = new Map(signals.map((s) => [s.id, s]));
  let autoActivated = 0;
  let activeCount = existing.length;
  const rows: Record<string, unknown>[] = [];

  for (const p of parsed.data.proposals) {
    // Support is counted from evidence that actually exists in this batch, not
    // from the model's own claim — a hallucinated id must not buy activation.
    const evidenceIds = [...new Set(p.evidence_signal_ids.filter((id) => validIds.has(id)))];
    if (!evidenceIds.length) continue;

    // Independence is measured in SESSIONS, not calendar days: someone who
    // reviews in one concentrated block every couple of weeks would never
    // accumulate two days, and midnight would split one sitting into two. A
    // single session can still teach a rule, but only by making the same point
    // on enough separate records that one frame of mind stops explaining it.
    const evidence = evidenceIds.map((id) => byId.get(id)!).filter(Boolean);
    const spread = evidenceIsIndependent(
      evidence.map((e) => ({ occurred_at: e.occurred_at, ref_id: e.ref_id })),
      AUTO_ACTIVATE_SUPPORT,
    );

    const qualifies =
      // A strategy replaces the approach rather than adding to it — too big a
      // change to make without a human, however strong the evidence looks.
      !strategyMode &&
      evidenceIds.length >= AUTO_ACTIVATE_SUPPORT &&
      p.confidence >= AUTO_ACTIVATE_CONFIDENCE &&
      spread.ok &&
      // At the cap a rule may only activate by replacing one, never by adding.
      (activeCount < MAX_ACTIVE_RULES || !!p.supersedes_rule_id);

    if (qualifies) {
      autoActivated += 1;
      if (!p.supersedes_rule_id) activeCount += 1;
    }

    rows.push({
      module,
      kind: strategyMode ? "strategy" : "rule",
      // The rejection rate this experiment is trying to beat. Without it,
      // "did the new approach work" has no answer a week from now.
      baseline_metric: strategyMode ? health?.reject_rate ?? null : null,
      scope: cleanScope(p.scope),
      rule_text: p.rule_text.trim(),
      rationale: p.rationale,
      status: qualifies ? "active" : "proposed",
      evidence: evidenceIds.map((id) => ({
        signal_id: id,
        before: byId.get(id)?.before_text ?? null,
        after: byId.get(id)?.after_text ?? null,
      })),
      support_count: evidenceIds.length,
      confidence: p.confidence,
      // Why this did or did not activate, in the operator's terms.
      baseline_note: strategyMode
        ? (health ? `${health.rejected} of ${health.judged} rejected when proposed` : null)
        : spread.reason,
      source: "analyzer",
      created_by: `analyzer:${MODEL}`,
      activated_at: qualifies ? new Date().toISOString() : null,
    });

    // Superseding is only honored for a rule that activates — otherwise a
    // proposal nobody approved could still silently retire a working rule.
    if (qualifies && p.supersedes_rule_id && validRuleId(existing, p.supersedes_rule_id)) {
      await supabase
        .from("prompt_rules")
        .update({
          status: "retired",
          retired_at: new Date().toISOString(),
          retire_reason: `superseded: ${p.rule_text.trim()}`,
          decided_by: "analyzer",
        })
        .eq("id", p.supersedes_rule_id);
      activeCount = Math.max(0, activeCount - 1);
    }
  }

  if (rows.length) {
    const { error } = await supabase.from("prompt_rules").insert(rows);
    if (error) throw new Error(`Could not store proposals: ${error.message}`);
  }

  // Only mark consumed after the proposals are safely stored: a crash between
  // the two should re-analyze, not silently drop the batch.
  await markProcessed(supabase, signals.map((s) => s.id));

  await recordRun(supabase, {
    module,
    signals_considered: signals.length,
    proposed: rows.length,
    auto_activated: autoActivated,
    model: MODEL,
    trigger,
    ...usage,
  });

  return {
    module,
    signalsConsidered: signals.length,
    proposed: rows.length,
    autoActivated,
  };
}

const validRuleId = (rules: PromptRule[], id: string) => rules.some((r) => r.id === id);

// Drop "any"/null scope keys so an unscoped rule stores {} and matches every run.
function cleanScope(scope: Proposal["scope"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scope)) {
    if (v && v !== "any") out[k] = v;
  }
  return out;
}

// Structured outputs return bare JSON, but a stray code fence costs nothing to
// tolerate and turns an unusable run into a usable one.
function safeJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function recordRun(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  await supabase.from("learning_runs").insert(row);
}
