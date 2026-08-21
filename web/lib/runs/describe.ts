import type { SourcingMode } from "../sourcing/prompts";

// Turns a run's stored config into the operator-facing answer to "what kind of
// run was this?". The config is the run's own record of what it was asked to
// do, so this never drifts from what actually happened — unlike a label typed
// at run start.

export type FlowRunEntryKind = "run" | "batch" | "import";

export type FlowRun = {
  entry_kind: FlowRunEntryKind;
  id: string;
  batch_id: string | null;
  module: string;
  status: string;
  executor: string | null;
  provider_label: string | null;
  config: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  batch_label: string | null;
  gate_status: string | null;
  sampled: number;
  graded: number;
  errors: number;
  pending: number;
  sourced: number;
  discarded: number;
  reviewed: number;
  enriched: number;
  personalized: number;
  drafted: number;
  sent: number;
  replied: number;
  drafts_created: number;
  /** Contacts of this run /draft would offer right now. */
  draftable: number;
  /** …of which these were explicitly sent back from the send queue. */
  awaiting_redraft: number;
  run_seq: number | null;
  run_mode_code: string | null;
  run_code: string | null;
  has_records: boolean;
};

const MODULE_LABEL: Record<string, string> = {
  sourcing: "Sourcing",
  enrichment: "Enrichment",
  personalization: "Personalization",
  drafting: "Drafting",
};

const MODE_LABEL: Record<SourcingMode, string> = {
  research_msps: "Target companies",
  research_customers: "Customers",
  find_customers_for_msps: "Customers of target companies",
  find_advisors_for_msps: "Referral partners of target companies",
};

function namedMsps(config: Record<string, unknown>): string[] {
  const msps = config.msps;
  if (!Array.isArray(msps)) return [];
  return msps
    .map((m) => (m && typeof m === "object" ? (m as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** The run's type — "Customers of Northwind IT", "MSP targets", "Drafting". */
export function runTypeLabel(run: Pick<FlowRun, "module" | "config">): string {
  const config = run.config ?? {};
  if (run.module !== "sourcing") return MODULE_LABEL[run.module] ?? run.module;

  const mode = config.mode as SourcingMode | undefined;
  if (mode === "find_customers_for_msps" || mode === "find_advisors_for_msps") {
    const noun = mode === "find_advisors_for_msps" ? "Referral partners" : "Customers";
    const names = namedMsps(config);
    if (!names.length) return `${noun} of target companies`;
    if (names.length <= 3) return `${noun} of ${names.join(", ")}`;
    return `${noun} of ${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
  }
  return mode ? MODE_LABEL[mode] ?? MODULE_LABEL.sourcing : MODULE_LABEL.sourcing;
}

/** Secondary metadata chips: who executed it, region, profile, how much was asked for. */
export function runDetailChips(
  run: Pick<FlowRun, "module" | "config" | "executor" | "provider_label">,
): string[] {
  const config = run.config ?? {};
  const chips: string[] = [];

  // Copy-paste is the default path and needs no label; a runner-executed run is
  // the exception worth marking, since nobody watched it happen in a browser.
  if (run.executor === "runner") {
    chips.push(run.provider_label ? `runner · ${run.provider_label}` : "runner");
  }
  const region = config.region;
  const profile = config.profile;
  const count = config.count;
  const countPer = config.countPer;

  if (typeof region === "string" && region.trim()) chips.push(region.trim());
  if (typeof profile === "string" && profile.trim()) chips.push(profile.trim());
  if (typeof count === "number" && count > 0) chips.push(`asked for ${count}`);
  if (typeof countPer === "number" && countPer > 0) chips.push(`${countPer} per target company`);
  return chips;
}

// The pipeline, in order. A run's output is "at" the furthest stage any of its
// records reached — the honest reading of progress, since stages never run
// backwards and a partially-advanced run is normal.
export const FLOW_STAGES = [
  { key: "sourced", label: "Sourced", href: "/review" },
  { key: "reviewed", label: "Reviewed", href: "/review" },
  { key: "enriched", label: "Enriched", href: "/review" },
  { key: "personalized", label: "Personalized", href: "/personalize" },
  { key: "drafted", label: "Drafted", href: "/draft" },
  { key: "sent", label: "Sent", href: "/draft/queue" },
] as const;

export type FlowStageKey = (typeof FLOW_STAGES)[number]["key"];

export function stageCounts(run: FlowRun): { key: FlowStageKey; label: string; count: number }[] {
  return FLOW_STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    count: run[s.key],
  }));
}

/** Furthest stage with at least one record, or null for a run that produced nothing. */
export function furthestStage(run: FlowRun): { key: FlowStageKey; label: string } | null {
  const reached = stageCounts(run).filter((s) => s.count > 0);
  const last = reached[reached.length - 1];
  return last ? { key: last.key, label: last.label } : null;
}

/**
 * What this run is waiting on, phrased as the next action. Null when it is done.
 *
 * Every stage link carries ?run=<id> so the action operates on THIS run's
 * records. Without it, "Personalize" on one run would open the stage across
 * every contact waiting there — the button would not mean what it says.
 */
export function nextAction(run: FlowRun): { label: string; href: string } | null {
  // Batch entries scope too — loadRunScope resolves their records via batch_id.
  // Only legacy imports can't: their contacts carry no lineage at all.
  const scoped = (path: string) =>
    run.entry_kind === "import" ? path : `${path}${path.includes("?") ? "&" : "?"}run=${run.id}`;

  if (run.status === "failed") return { label: "Run failed — start a new run", href: "/source" };
  if (run.status === "awaiting_input")
    return { label: "Paste the model's output", href: "/source" };
  // Grading is the step people forget, because nothing in the funnel counts it
  // and its absence looks like a stall rather than a queue. Say what it unlocks.
  if (run.pending > 0)
    return {
      label: `Grade ${run.pending} to unlock enrichment`,
      href: `/review/grade?batch=${run.batch_id}`,
    };
  if (run.gate_status === "failed")
    return { label: "Gate failed — revise the prompt", href: "/settings" };
  // A batch with records but nothing sampled can never pass: there is nothing
  // to grade. Sampling now keeps a floor of one, so this is old data or an
  // edge case — either way, say so rather than stalling silently.
  if (run.gate_status === "open" && run.sampled === 0 && run.sourced > 0)
    return {
      label: "Nothing sampled — gate cannot pass",
      href: `/review/grade?batch=${run.batch_id}`,
    };
  if (run.sourced > run.reviewed)
    return { label: "Review the contacts", href: scoped("/review") };
  // Clay has a permanent tail. Some contacts never write back at all — run 30-C
  // pushed 20, saw 19 return within four minutes, and the twentieth never came —
  // and some come back with nothing usable, which lands as `low_confidence` or
  // `failed` rather than `enriched`. So "every reviewed contact is enriched" is a
  // state an external service can withhold forever, and waiting on it is not an
  // action anyone can take: the run stalls here with its remaining stages ready.
  //
  // Once anything has come back, enrichment counts as underway and the run moves
  // on. Two cases this deliberately cannot see, both needing a count of contacts
  // never pushed (`contacts.clay_pushed_at is null`) that flow_runs does not
  // carry today:
  //
  //   - a PARTIAL push (10 of 20 sent) advances, with no reminder about the rest;
  //   - a run whose every writeback was low_confidence still reads "Enrich via
  //     Clay", while the enrich queue is empty because all of them were pushed.
  if (run.reviewed > run.enriched && run.enriched === 0)
    return { label: "Enrich via Clay", href: scoped("/review") };
  // A rejected draft outranks the pipeline's default order: the operator has
  // already looked at these and asked for them again, which is a more specific
  // instruction than "this stage usually comes next". Without this, a run whose
  // contacts carry no hooks sits on Personalize while rejected drafts wait.
  if (run.awaiting_redraft > 0)
    return {
      label: `Redraft ${run.awaiting_redraft}`,
      href: scoped("/draft"),
    };
  if (run.enriched > run.personalized)
    return { label: "Personalize", href: scoped("/personalize") };
  if (run.personalized > run.drafted) return { label: "Draft", href: scoped("/draft") };
  // Personalization may legitimately find no hook, so a run can be ready to
  // draft with personalized still at zero. Offer it rather than stalling.
  if (run.draftable > 0) return { label: "Draft", href: scoped("/draft") };
  if (run.drafted > run.sent) return { label: "Send", href: scoped("/draft/queue") };
  return null;
}
