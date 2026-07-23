"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ExternalLink, Check, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { submitGrade, type FieldGrade } from "@/lib/grading/actions";
import type { GateMetrics } from "@/lib/grading/gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactKindBadge } from "@/components/contact-kind-badge";
import { Textarea } from "@/components/ui/textarea";

export type GradeContact = {
  id: string;
  batch_id: string | null;
  module: string;
  batch_label: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  personalization: string | null;
  confidence: string | null;
  source_url: string | null;
  evidence: { url: string; via?: string }[];
  org_name: string;
  org_domain: string | null;
  org_kind: string | null; // 'msp' (acquisition target) | 'customer' | 'unknown' (legacy default)
  customer_of: string | null; // resolved MSP name, only for kind='customer' contacts
};

// Which contact fields are correctable for each module, and the property each maps to.
const FIELDS_BY_MODULE: Record<string, { field: string; prop: keyof GradeContact; label: string; long?: boolean }[]> = {
  sourcing: [
    { field: "name", prop: "full_name", label: "Name" },
    { field: "title", prop: "title", label: "Title" },
    { field: "linkedin", prop: "linkedin_url", label: "LinkedIn" },
  ],
  enrichment: [
    { field: "email", prop: "email", label: "Email" },
    { field: "phone", prop: "phone", label: "Phone" },
    { field: "linkedin", prop: "linkedin_url", label: "LinkedIn" },
  ],
  personalization: [
    { field: "personalization", prop: "personalization", label: "Personalization", long: true },
  ],
  drafting: [{ field: "personalization", prop: "personalization", label: "Note", long: true }],
};

// Error taxonomy — mirrors the grades.error_category CHECK. One-tap chips;
// 'other' is the escape hatch so categorizing never blocks a grade for long.
const ERROR_CATEGORIES = [
  { value: "stale_data", label: "stale data" },
  { value: "wrong_person", label: "wrong person" },
  { value: "wrong_company", label: "wrong company" },
  { value: "hallucinated", label: "hallucinated" },
  { value: "bad_evidence", label: "bad evidence" },
  { value: "formatting", label: "formatting" },
  { value: "misaligned_note", label: "misaligned note" },
  { value: "other", label: "other" },
];

function CategoryChips({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ERROR_CATEGORIES.map((cat) => (
        <Button
          key={cat.value}
          size="xs"
          variant={selected === cat.value ? "default" : "outline"}
          onClick={() => onSelect(cat.value)}
        >
          {cat.label}
        </Button>
      ))}
    </div>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

export function GradeQueue({
  contacts,
  initialMetricsByBatch,
}: {
  contacts: GradeContact[];
  initialMetricsByBatch: Record<string, GateMetrics>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [index, setIndex] = useState(0);
  const [metricsByBatch, setMetricsByBatch] = useState(initialMetricsByBatch);
  const [correcting, setCorrecting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  // Per-changed-field error category (correct flow) and record-level category +
  // optional reason (reject flow).
  const [fieldCategories, setFieldCategories] = useState<Record<string, string>>({});
  const [rejectCategory, setRejectCategory] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  // When the current card appeared — grades carry coarse seconds_spent.
  const [shownAt, setShownAt] = useState(() => Date.now());

  // Snapshot the list on mount so grading the whole queue is stable: submitGrade
  // revalidates this route, which would otherwise re-render us with a shorter
  // contacts prop and shift the record under our index. We advance through the
  // original snapshot and only update gate metrics from each grade's result.
  const [queue] = useState(() => contacts);
  const current = queue[index];
  const currentModule = current?.module ?? "sourcing";
  const fields = useMemo(
    () => FIELDS_BY_MODULE[currentModule] ?? FIELDS_BY_MODULE.sourcing,
    [currentModule],
  );
  const currentMetrics = current?.batch_id ? metricsByBatch[current.batch_id] : undefined;

  const draftsFor = useCallback(
    (c: GradeContact | undefined): Record<string, string> => {
      const d: Record<string, string> = {};
      const fs = c ? FIELDS_BY_MODULE[c.module] ?? FIELDS_BY_MODULE.sourcing : [];
      if (c) for (const f of fs) d[f.field] = (c[f.prop] as string | null) ?? "";
      return d;
    },
    [],
  );

  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsFor(queue[0]));

  // Reset editable state when the queue advances to a new contact (the React
  // "adjust state during render on prop change" pattern — not an effect).
  const [trackedId, setTrackedId] = useState(current?.id);
  if (current?.id !== trackedId) {
    setTrackedId(current?.id);
    setCorrecting(false);
    setRejecting(false);
    setFieldCategories({});
    setRejectCategory(null);
    setRejectReason("");
    setDrafts(draftsFor(current));
    setShownAt(Date.now());
  }

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
  }, []);

  const grade = useCallback(
    (
      decision: "approved" | "corrected" | "rejected",
      extras?: { fieldGrades?: FieldGrade[]; errorCategory?: string | null; reason?: string | null },
    ) => {
      if (!current) return;
      const batchId = current.batch_id;
      const prevStatus = batchId ? metricsByBatch[batchId]?.status : undefined;
      const secondsSpent = Math.max(0, Math.round((Date.now() - shownAt) / 1000));
      startTransition(async () => {
        try {
          const m = await submitGrade({
            contactId: current.id,
            module: current.module,
            batchId,
            decision,
            fieldGrades: extras?.fieldGrades,
            errorCategory: extras?.errorCategory ?? null,
            reason: extras?.reason ?? null,
            secondsSpent,
          });
          if (m && batchId) setMetricsByBatch((prev) => ({ ...prev, [batchId]: m }));
          advance();
          // Only announce a gate result when it actually flips for this batch.
          if (m && m.status !== prevStatus) {
            if (m.status === "failed")
              toast.error(`Batch "${current.batch_label}" gate FAILED — error rate over threshold.`);
            else if (m.status === "passed")
              toast.success(`Batch "${current.batch_label}" gate PASSED.`);
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Grade failed.");
        }
      });
    },
    [current, metricsByBatch, advance, shownAt],
  );

  // Fields whose draft differs from the record — each needs an error category
  // before the correction can be submitted.
  const changedFields = useMemo(
    () =>
      current
        ? fields.filter(
            (f) => (drafts[f.field] ?? "").trim() !== ((current[f.prop] as string | null) ?? "").trim(),
          )
        : [],
    [current, fields, drafts],
  );
  const missingCategories = changedFields.some((f) => !fieldCategories[f.field]);

  const saveCorrection = useCallback(() => {
    if (!current) return;
    if (!changedFields.length) {
      toast.message("No changes — use Approve if the record is correct.");
      return;
    }
    if (changedFields.some((f) => !fieldCategories[f.field])) {
      toast.message("Pick an error category for each changed field.");
      return;
    }
    const fieldGrades: FieldGrade[] = changedFields.map((f) => {
      const original = (current[f.prop] as string | null) ?? "";
      const next = (drafts[f.field] ?? "").trim();
      return {
        field: f.field,
        verdict: original.trim() ? "wrong" : "missing",
        correction: next || null,
        previousValue: original || null,
        errorCategory: fieldCategories[f.field],
      };
    });
    grade("corrected", { fieldGrades });
  }, [current, changedFields, fieldCategories, drafts, grade]);

  const submitReject = useCallback(() => {
    if (!rejectCategory) {
      toast.message("Pick an error category to reject.");
      return;
    }
    grade("rejected", { errorCategory: rejectCategory, reason: rejectReason.trim() || null });
  }, [rejectCategory, rejectReason, grade]);

  // Keyboard shortcuts (ignored while typing in a field, and only for plain
  // unmodified keys — Cmd/Ctrl+A must select text, not approve).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (pending) return;
      if (e.key === "a") grade("approved");
      else if (e.key === "r") {
        // Reject needs a category, so 'r' opens the panel rather than submitting.
        setRejecting((v) => !v);
        setCorrecting(false);
      } else if (e.key === "c") {
        setCorrecting((v) => !v);
        setRejecting(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade, pending]);

  const done = index >= queue.length;
  const batchSummary = useMemo(() => {
    const vals = Object.values(metricsByBatch);
    return {
      passed: vals.filter((m) => m.status === "passed").length,
      failed: vals.filter((m) => m.status === "failed").length,
      open: vals.filter((m) => m.status === "open").length,
      total: vals.length,
    };
  }, [metricsByBatch]);

  return (
    <div className="flex flex-col gap-4">
      {/* Gate header — reflects the CURRENT contact's batch */}
      <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
        {currentMetrics ? (
          <>
            <Badge variant={statusVariant(currentMetrics.status)}>
              gate: {currentMetrics.status}
            </Badge>
            <span className="text-muted-foreground">
              graded {currentMetrics.gradedCount}/{currentMetrics.sampleSize}
            </span>
            <span className="text-muted-foreground">
              errors {currentMetrics.errorCount} ({(currentMetrics.errorRate * 100).toFixed(0)}%)
            </span>
            <span className="text-muted-foreground">
              threshold {(currentMetrics.threshold * 100).toFixed(0)}%
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {batchSummary.passed} passed · {batchSummary.failed} failed · {batchSummary.open} open
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {done ? "queue complete" : `${index + 1} of ${queue.length}`}
        </span>
      </div>

      {done ? (
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm">
            Graded everything in the queue — {batchSummary.total} batch
            {batchSummary.total === 1 ? "" : "es"}: {batchSummary.passed} passed,{" "}
            {batchSummary.failed} failed, {batchSummary.open} still open (sample not yet
            sufficient).
          </p>
          <p className="text-sm text-muted-foreground">
            {batchSummary.passed > 0
              ? "Passed batches can advance. If contacts still need emails, push them to Clay from Review & Enrich (part B), then draft."
              : batchSummary.failed > 0
                ? "No batch passed. Revise the sourcing approach and start a fresh run — failed batches shouldn't advance."
                : "Batches still open need more graded samples before the gate can decide."}
          </p>
          <div className="flex flex-wrap gap-2">
            {batchSummary.passed > 0 && (
              <Button nativeButton={false} render={<Link href="/review" />}>
                Review & Enrich (step 2) →
              </Button>
            )}
            {batchSummary.passed > 0 && (
              <Button variant="outline" nativeButton={false} render={<Link href="/draft" />}>
                Or draft if already enriched (step 5) →
              </Button>
            )}
            {batchSummary.failed > 0 && batchSummary.passed === 0 && (
              <Button nativeButton={false} render={<Link href="/source" />}>
                Start a revised run →
              </Button>
            )}
            <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
              Back to runs
            </Button>
            <Button variant="ghost" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        current && (
          <div className="flex flex-col gap-4 rounded-md border p-5">
            {/* Record header */}
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-medium">{current.full_name ?? "—"}</div>
                <div className="text-sm text-muted-foreground">
                  {current.title ? `${current.title} · ` : ""}
                  {current.org_name}
                  {current.org_domain ? ` (${current.org_domain})` : ""}
                </div>
                {current.customer_of && (
                  <div className="text-xs text-muted-foreground">
                    Customer of {current.customer_of}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ContactKindBadge kind={current.org_kind} />
                <Badge variant="outline">{current.batch_label}</Badge>
                {current.persona && <Badge variant="outline">{current.persona}</Badge>}
                {current.confidence && <Badge variant="secondary">{current.confidence}</Badge>}
              </div>
            </div>

            {/* Evidence */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Evidence:</span>
              {current.evidence.length ? (
                current.evidence.map((e, i) => (
                  <a
                    key={i}
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {e.via ?? "source"}
                  </a>
                ))
              ) : current.source_url ? (
                <a
                  href={current.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="size-3" />
                  source
                </a>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </div>

            {/* Correct mode: editable fields */}
            {correcting && (
              <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-3">
                {fields.map((f) => {
                  const changed = changedFields.some((cf) => cf.field === f.field);
                  return (
                    <div key={f.field} className="flex flex-col gap-1.5">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">{f.label}</span>
                        {f.long ? (
                          <Textarea
                            value={drafts[f.field] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                            rows={3}
                          />
                        ) : (
                          <Input
                            value={drafts[f.field] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                          />
                        )}
                      </label>
                      {/* A changed field must carry an error category before submit. */}
                      {changed && (
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            What was wrong with {f.label.toLowerCase()}?
                          </span>
                          <CategoryChips
                            selected={fieldCategories[f.field] ?? null}
                            onSelect={(v) =>
                              setFieldCategories((m) => ({ ...m, [f.field]: v }))
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending || !changedFields.length || missingCategories}
                    onClick={saveCorrection}
                  >
                    Save corrections
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDrafts(draftsFor(current));
                      setFieldCategories({});
                      setCorrecting(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Reject mode: record-level category (required) + optional reason */}
            {rejecting && (
              <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
                <span className="text-xs text-muted-foreground">Why is this record wrong?</span>
                <CategoryChips selected={rejectCategory} onSelect={setRejectCategory} />
                <Input
                  placeholder="Reason (optional, one line)"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && rejectCategory && !pending) submitReject();
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending || !rejectCategory}
                    onClick={submitReject}
                  >
                    Reject record
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRejectCategory(null);
                      setRejectReason("");
                      setRejecting(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Decision bar */}
            <div className="flex items-center gap-2">
              <Button disabled={pending} onClick={() => grade("approved")}>
                <Check className="size-4" /> Approve <kbd className="ml-1 text-xs opacity-70">a</kbd>
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setCorrecting((v) => !v);
                  setRejecting(false);
                }}
              >
                <Pencil className="size-4" /> Correct <kbd className="ml-1 text-xs opacity-70">c</kbd>
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setRejecting((v) => !v);
                  setCorrecting(false);
                }}
              >
                <X className="size-4" /> Reject <kbd className="ml-1 text-xs opacity-70">r</kbd>
              </Button>
            </div>
          </div>
        )
      )}
      <p className="text-xs text-muted-foreground">
        Shortcuts: <kbd>a</kbd> approve · <kbd>c</kbd> correct · <kbd>r</kbd> reject. Corrections and
        rejects carry an error category; every decision is recorded as eval-set grades (approvals
        included) and corrections are written back to the contact.
      </p>
    </div>
  );
}
