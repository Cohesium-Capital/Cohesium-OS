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
  research_msps: "MSP targets",
  research_customers: "Customers",
  find_customers_for_msps: "Customers of MSPs",
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
  if (mode === "find_customers_for_msps") {
    const names = namedMsps(config);
    if (!names.length) return "Customers of MSPs";
    if (names.length <= 3) return `Customers of ${names.join(", ")}`;
    return `Customers of ${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
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
  if (typeof countPer === "number" && countPer > 0) chips.push(`${countPer} per MSP`);
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
  if (run.pending > 0)
    return { label: `Grade ${run.pending}`, href: `/review/grade?batch=${run.batch_id}` };
  if (run.gate_status === "failed")
    return { label: "Gate failed — revise the prompt", href: "/settings" };
  if (run.sourced > run.reviewed)
    return { label: "Review the contacts", href: scoped("/review") };
  if (run.reviewed > run.enriched) return { label: "Enrich via Clay", href: scoped("/review") };
  if (run.enriched > run.personalized)
    return { label: "Personalize", href: scoped("/personalize") };
  if (run.personalized > run.drafted) return { label: "Draft", href: scoped("/draft") };
  if (run.drafted > run.sent) return { label: "Send", href: scoped("/draft/queue") };
  return null;
}
