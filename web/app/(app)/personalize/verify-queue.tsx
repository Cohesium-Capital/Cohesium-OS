"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ExternalLink, Check, X } from "lucide-react";
import { toast } from "sonner";
import { verifyHook, type HookRejectCategory } from "@/lib/hooks/actions";
import type { GateMetrics } from "@/lib/grading/gate";
import { sourceIsFresh, SOURCE_MAX_AGE_MONTHS } from "@/lib/hooks/usable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ContactKindBadge } from "@/components/contact-kind-badge";

// Keyboard-first hook verification, card at a time. The grader CLICKS the
// source URL and answers: does it support THIS claim, and is the claim
// specific to this person/company? Both yes = verified; anything else is a
// categorized reject. kind='none' cards ask a single different question —
// is the fallback angle honest and non-generic? — because "no hook" is a
// first-class outcome, never an error by construction.

export type VerifyHook = {
  id: string;
  batch_id: string | null;
  batch_label: string;
  text: string | null;
  kind: string;
  fallback_angle: string | null;
  source_url: string | null;
  source_published_at: string | null;
  track: string | null;
  contact_name: string | null;
  contact_title: string | null;
  org_name: string;
  org_domain: string | null;
  org_kind: string | null;
};

// One button per reject category, each with a single-key shortcut; all are
// legal grades.error_category values. 'generic' exists because a verifiable
// but unspecific claim ("they have a website") games the URL check.
const REJECTS: { key: string; value: HookRejectCategory; label: string }[] = [
  { key: "h", value: "hallucinated", label: "Hallucinated" },
  { key: "s", value: "stale_data", label: "Stale" },
  { key: "b", value: "bad_evidence", label: "Bad evidence" },
  { key: "g", value: "generic", label: "Generic" },
  { key: "w", value: "wrong_person", label: "Wrong person" },
  { key: "o", value: "other", label: "Other" },
];

const KIND_LABELS: Record<string, string> = {
  talk: "talk",
  news: "news",
  post: "post",
  award: "award",
  role_change: "role change",
  company_news: "company news",
  other: "other",
  none: "no hook",
};

function statusVariant(s: string): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

export function VerifyQueue({
  hooks,
  initialMetricsByBatch,
}: {
  hooks: VerifyHook[];
  initialMetricsByBatch: Record<string, GateMetrics>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [index, setIndex] = useState(0);
  const [metricsByBatch, setMetricsByBatch] = useState(initialMetricsByBatch);
  // When the current card appeared — verdicts carry coarse seconds_spent, the
  // fatigue guard's raw material (a 2-second "verified" is a rubber stamp).
  const [shownAt, setShownAt] = useState(() => Date.now());

  // Snapshot the list on mount so verifying the whole queue is stable:
  // verifyHook revalidates this route, which would otherwise re-render us with
  // a shorter hooks prop and shift the card under our index.
  const [queue, setQueue] = useState(() => hooks);
  // Reconcile fresh props into the snapshot (render-time state adjustment):
  // router.refresh() after an import delivers a new hooks prop; append rows we
  // haven't seen so new work surfaces without shifting the operator's position.
  const [lastProp, setLastProp] = useState(hooks);
  if (hooks !== lastProp) {
    setLastProp(hooks);
    setQueue((q) => [...q, ...hooks.filter((h) => !q.some((x) => x.id === h.id))]);
    // Server-computed gate metrics are fresher than our per-verdict copies.
    setMetricsByBatch((m) => ({ ...m, ...initialMetricsByBatch }));
  }

  const current = queue[index];
  const done = index >= queue.length;
  const currentMetrics = current?.batch_id ? metricsByBatch[current.batch_id] : undefined;
  const isNone = current?.kind === "none";

  // Reset the card timer when the queue advances (the React "adjust state
  // during render on prop change" pattern — not an effect).
  const [trackedId, setTrackedId] = useState(current?.id);
  if (current?.id !== trackedId) {
    setTrackedId(current?.id);
    setShownAt(Date.now());
  }

  const decide = useCallback(
    (verdict: "verified" | "rejected", category?: HookRejectCategory) => {
      if (!current) return;
      const batchId = current.batch_id;
      const prevStatus = batchId ? metricsByBatch[batchId]?.status : undefined;
      const secondsSpent = Math.max(0, Math.round((Date.now() - shownAt) / 1000));
      startTransition(async () => {
        try {
          const res = await verifyHook({ hookId: current.id, verdict, category, secondsSpent });
          const m = res.metrics;
          if (m && batchId) setMetricsByBatch((prev) => ({ ...prev, [batchId]: m }));
          // Advance regardless: an already-decided card (double-submit or a
          // second grader) and a bookkeeping warning both leave the verdict
          // settled — trapping the operator here helps no one.
          setIndex((i) => i + 1);
          if (res.alreadyDecided) toast.info("Hook was already decided — skipping ahead.");
          if (res.warning) toast.warning(res.warning);
          // Only announce a gate result when it actually flips for this batch.
          if (m && m.status !== prevStatus) {
            if (m.status === "failed")
              toast.error(`Batch "${current.batch_label}" gate FAILED — reject rate over threshold.`);
            else if (m.status === "passed")
              toast.success(`Batch "${current.batch_label}" gate PASSED — its hooks are draftable.`);
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Verdict failed.");
        }
      });
    },
    [current, metricsByBatch, shownAt],
  );

  // Keyboard shortcuts (ignored while typing; only plain unmodified keys —
  // Cmd+W must close a tab, never mark wrong_person).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el?.isContentEditable) return;
      if (pending || !current) return;
      if (e.key === "v") {
        decide("verified");
        return;
      }
      const r = REJECTS.find((x) => x.key === e.key);
      // kind='none' cards take a single judgment: honest fallback (v) or
      // generic filler (g). Other reject categories don't apply to no-hook rows.
      if (r && (!isNone || r.value === "generic")) decide("rejected", r.value);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, pending, current, isNone]);

  const stale =
    !!current?.source_published_at && !sourceIsFresh(current.source_published_at);

  return (
    <div className="flex flex-col gap-4">
      {/* Gate header — reflects the CURRENT card's batch */}
      <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
        {currentMetrics ? (
          <>
            <Badge variant={statusVariant(currentMetrics.status)}>
              gate: {currentMetrics.status}
            </Badge>
            <span className="text-muted-foreground">
              verified {currentMetrics.gradedCount}/{currentMetrics.sampleSize}
            </span>
            <span className="text-muted-foreground">
              rejected {currentMetrics.errorCount} (
              {(currentMetrics.errorRate * 100).toFixed(0)}%)
            </span>
            <span className="text-muted-foreground">
              threshold {(currentMetrics.threshold * 100).toFixed(0)}%
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">hook verification</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {done ? "queue complete" : `${index + 1} of ${queue.length}`}
        </span>
      </div>

      {done ? (
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm">
            {queue.length === 0
              ? "Nothing to verify — sampled hooks land here before drafting consumes them."
              : `Verified everything in the queue — ${queue.length} hook${queue.length === 1 ? "" : "s"}.`}
          </p>
          <p className="text-sm text-muted-foreground">
            {queue.length === 0
              ? "Start a hook research run above; the ingest samples a slice of every batch for this check."
              : "Batches that passed their gate release their hooks to drafting; failed batches go back to research with a better prompt."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button nativeButton={false} render={<Link href="/draft" />}>
              Draft messages (step 5) →
            </Button>
            <Button variant="ghost" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        current && (
          <div className="flex flex-col gap-4 rounded-md border p-5">
            {/* Card header: who this claim is about */}
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-medium">{current.contact_name ?? "—"}</div>
                <div className="text-sm text-muted-foreground">
                  {current.contact_title ? `${current.contact_title} · ` : ""}
                  {current.org_name}
                  {current.org_domain ? ` (${current.org_domain})` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ContactKindBadge kind={current.org_kind} />
                <Badge variant={isNone ? "secondary" : "outline"}>
                  {KIND_LABELS[current.kind] ?? current.kind}
                </Badge>
                {current.track && <Badge variant="outline">{current.track}</Badge>}
                <Badge variant="outline">{current.batch_label}</Badge>
              </div>
            </div>

            {isNone ? (
              <>
                {/* No-hook card: judge the fallback angle, nothing else. */}
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Fallback angle (no hook found)
                  </p>
                  <p className="mt-1 text-sm leading-relaxed">
                    {current.fallback_angle ?? "—"}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  &ldquo;No hook&rdquo; is the honest outcome when nothing verifiable exists —
                  never mark it down for existing. One judgment: is this fallback angle honest
                  and specific to their role/industry, not generic filler?
                </p>
                <div className="flex items-center gap-2">
                  <Button disabled={pending} onClick={() => decide("verified")}>
                    <Check className="size-4" /> Honest fallback{" "}
                    <kbd className="ml-1 text-xs opacity-70">v</kbd>
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending}
                    onClick={() => decide("rejected", "generic")}
                  >
                    <X className="size-4" /> Generic{" "}
                    <kbd className="ml-1 text-xs opacity-70">g</kbd>
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* The claim — what the grader is checking. */}
                <div className="rounded-md bg-muted/40 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Claim
                  </p>
                  <p className="mt-1 text-sm leading-relaxed">{current.text ?? "—"}</p>
                </div>

                {/* The source — the ground truth. The grader clicks it. */}
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {current.source_url ? (
                    <a
                      href={current.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-3 py-2 font-medium text-primary transition-colors hover:bg-accent"
                    >
                      <ExternalLink className="size-4 shrink-0" />
                      <span className="truncate">{current.source_url}</span>
                    </a>
                  ) : (
                    <Badge variant="destructive">no source URL</Badge>
                  )}
                  {current.source_published_at && (
                    <Badge variant={stale ? "destructive" : "secondary"}>
                      published {new Date(current.source_published_at).toLocaleDateString()}
                      {stale ? ` — over ${SOURCE_MAX_AGE_MONTHS} months old` : ""}
                    </Badge>
                  )}
                </div>

                {/* Decision bar: verified needs BOTH — URL supports the claim
                    AND the claim is specific to this person/company. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={pending} onClick={() => decide("verified")}>
                    <Check className="size-4" /> Verified{" "}
                    <kbd className="ml-1 text-xs opacity-70">v</kbd>
                  </Button>
                  {REJECTS.map((r) => (
                    <Button
                      key={r.value}
                      variant="outline"
                      disabled={pending}
                      onClick={() => decide("rejected", r.value)}
                    >
                      {r.label} <kbd className="ml-1 text-xs opacity-70">{r.key}</kbd>
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: <kbd>v</kbd> verified · <kbd>h</kbd> hallucinated · <kbd>s</kbd> stale ·{" "}
        <kbd>b</kbd> bad evidence · <kbd>g</kbd> generic · <kbd>w</kbd> wrong person ·{" "}
        <kbd>o</kbd> other. Verified requires both checks: the source supports the exact claim,
        and the claim is specific to this person or company. Every verdict writes a grade row
        and recomputes the batch gate.
      </p>
    </div>
  );
}
