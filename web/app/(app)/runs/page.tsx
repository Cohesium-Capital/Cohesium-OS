import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  type FlowRun,
  furthestStage,
  nextAction,
  runDetailChips,
  runTypeLabel,
  stageCounts,
} from "@/lib/runs/describe";
import { formatDateTime, relativeTime } from "@/lib/format/date";
import { RunBadge } from "@/components/run-badge";

// Runs hub, read vertically: newest run at the top, and for each one what it
// was, when it ran, what it produced, and how far that output has travelled
// through the pipeline. The eval gate lives inside each entry rather than in a
// column of its own — grading is one thing a run is waiting on, alongside
// review, enrichment and drafting.

const PAGE_SIZE = 20;

function gateVariant(s: string | null): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

const STATUS_LABEL: Record<string, string> = {
  queued: "queued",
  awaiting_input: "awaiting paste",
  running: "running",
  ingesting: "importing",
  review_ready: "imported",
  failed: "failed",
};

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const supabase = await createClient();

  // Only runs that actually produced records. A prompt generated but never
  // pasted back is not yet a run worth tracking — it has nothing to open, and
  // listing it buries the runs that do.
  const { data, count } = await supabase
    .from("flow_runs")
    .select("*", { count: "exact" })
    .eq("has_records", true)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const runs = (data ?? []) as unknown as FlowRun[];
  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Header summary across every run (cheap: the view is already aggregated).
  const { data: allRows } = await supabase
    .from("flow_runs")
    .select("gate_status, pending, sourced, status")
    .eq("has_records", true);
  const summary = (allRows ?? []) as unknown as Pick<
    FlowRun,
    "gate_status" | "pending" | "sourced" | "status"
  >[];
  const needGrading = summary.filter((r) => r.pending > 0).length;
  const contactsSourced = summary.reduce((n, r) => n + (r.sourced ?? 0), 0);
  const failed = summary.filter((r) => r.status === "failed").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Runs</h1>
          <p className="text-sm text-muted-foreground">
            Every run that produced records, newest first — what it looked for, when it ran, and
            where its output currently sits in the pipeline. Runs still awaiting their pasted
            output are not listed until they have records. Open one to see those records; the
            action button on each entry acts on that run alone.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/source" />}>
            New sourcing run
          </Button>
          {needGrading > 0 && (
            <Button nativeButton={false} render={<Link href="/review/grade" />}>
              Grade next ({needGrading})
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Runs" value={total} />
        <SummaryCard label="Contacts sourced" value={contactsSourced} />
        <SummaryCard label="Need grading" value={needGrading} accent />
        <SummaryCard label="Failed" value={failed} />
      </div>

      <div data-tour="runs-table">
        {runs.length ? (
          <ol className="flex flex-col">
            {runs.map((run, i) => (
              <RunEntry key={run.id} run={run} last={i === runs.length - 1} />
            ))}
          </ol>
        ) : (
          <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
            No runs with records yet. Start a sourcing run and import the results — a run
            appears here once its output has been pasted back.
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
        <span>
          {total} run{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          nativeButton={false}
          render={<Link href={`/runs?page=${page - 1}`} />}
        >
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          nativeButton={false}
          render={<Link href={`/runs?page=${page + 1}`} />}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function RunEntry({ run, last }: { run: FlowRun; last: boolean }) {
  const stages = stageCounts(run);
  const furthest = furthestStage(run);
  const action = nextAction(run);
  const chips = runDetailChips(run);
  const isDrafting = run.module === "drafting";

  return (
    <li className="flex gap-4">
      {/* Rail: the dot marks this run, the line ties it to the one below. */}
      <div className="flex flex-col items-center">
        <span
          className={`mt-5 size-3 shrink-0 rounded-full ring-4 ring-background ${
            run.status === "failed"
              ? "bg-destructive"
              : action
                ? "bg-primary"
                : "bg-muted-foreground/40"
          }`}
        />
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>

      <div className="mb-3 min-w-0 flex-1 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-medium">
              <RunBadge code={run.run_code} />
              {run.entry_kind === "import" ? (
                runTypeLabel(run)
              ) : (
                <Link href={`/runs/${run.id}`} className="underline-offset-2 hover:underline">
                  {runTypeLabel(run)}
                </Link>
              )}
            </h2>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(run.created_at)} · {relativeTime(run.created_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {run.gate_status && (
              <Badge variant={gateVariant(run.gate_status)}>gate {run.gate_status}</Badge>
            )}
            <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
              {STATUS_LABEL[run.status] ?? run.status}
            </Badge>
          </div>
        </div>

        {(chips.length > 0 || run.entry_kind !== "run") && (
          <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {chips.map((c) => (
              <span key={c} className="rounded bg-muted px-1.5 py-0.5">
                {c}
              </span>
            ))}
            {run.entry_kind === "import" && (
              <span className="rounded bg-muted px-1.5 py-0.5">
                direct import — predates run tracking, so only its import totals are known
              </span>
            )}
            {run.entry_kind === "batch" && (
              <span className="rounded bg-muted px-1.5 py-0.5">
                batch without a run record
              </span>
            )}
          </p>
        )}

        {run.error && (
          <p className="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {run.error}
          </p>
        )}

        {isDrafting ? (
          <p className="mt-3 text-sm">
            <span className="font-semibold tabular-nums">{run.drafts_created}</span>{" "}
            <span className="text-muted-foreground">draft(s) written</span>
          </p>
        ) : (
          <FlowBar run={run} stages={stages} />
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {run.sampled > 0 && (
            <span>
              graded {run.graded}/{run.sampled}
              {run.errors > 0 ? ` · ${run.errors} error${run.errors === 1 ? "" : "s"}` : ""}
            </span>
          )}
          {run.discarded > 0 && <span>{run.discarded} discarded in review</span>}
          {furthest && <span>furthest stage: {furthest.label}</span>}
          {run.replied > 0 && <span>{run.replied} replied</span>}
          <span className="ml-auto flex gap-2">
            {run.entry_kind !== "import" && (
              <Button
                size="sm"
                variant="ghost"
                nativeButton={false}
                render={<Link href={`/runs/${run.id}`} />}
              >
                View records
              </Button>
            )}
            {action && (
              <Button
                size="sm"
                variant={run.pending > 0 ? "default" : "outline"}
                nativeButton={false}
                render={<Link href={action.href} />}
              >
                {action.label}
              </Button>
            )}
          </span>
        </div>
      </div>
    </li>
  );
}

// Horizontal funnel inside the entry: each stage's share of what the run
// sourced. Counts are cumulative-by-nature (a sent contact was also drafted,
// enriched, reviewed), so the bars only ever shrink left to right.
function FlowBar({
  run,
  stages,
}: {
  run: FlowRun;
  stages: { key: string; label: string; count: number }[];
}) {
  const base = run.sourced || 0;
  if (!base) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No records attributed to this run.
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex gap-1">
        {stages.map((s) => {
          const pct = Math.round((s.count / base) * 100);
          return (
            <div key={s.key} className="flex-1" title={`${s.label}: ${s.count} of ${base}`}>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 text-xs">
        {stages.map((s) => (
          <span key={s.key} className="flex-1 truncate">
            <span
              className={`tabular-nums ${s.count > 0 ? "font-medium" : "text-muted-foreground"}`}
            >
              {s.count}
            </span>{" "}
            <span className="text-muted-foreground">{s.label.toLowerCase()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`flex min-w-32 flex-col rounded-lg border px-4 py-3 ${
        accent && value > 0 ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
