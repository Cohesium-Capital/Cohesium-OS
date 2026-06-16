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
import { Textarea } from "@/components/ui/textarea";

export type GradeContact = {
  id: string;
  batch_id: string | null;
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

function statusVariant(s: string): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

export function GradeQueue({
  module,
  batchId,
  initialMetrics,
  contacts,
}: {
  module: string;
  batchId: string;
  initialMetrics: GateMetrics;
  contacts: GradeContact[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [index, setIndex] = useState(0);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [correcting, setCorrecting] = useState(false);

  const current = contacts[index];
  const fields = useMemo(() => FIELDS_BY_MODULE[module] ?? FIELDS_BY_MODULE.sourcing, [module]);

  const draftsFor = useCallback(
    (c: GradeContact | undefined): Record<string, string> => {
      const d: Record<string, string> = {};
      if (c) for (const f of fields) d[f.field] = (c[f.prop] as string | null) ?? "";
      return d;
    },
    [fields],
  );

  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsFor(contacts[0]));

  // Reset editable state when the queue advances to a new contact (the React
  // "adjust state during render on prop change" pattern — not an effect).
  const [trackedId, setTrackedId] = useState(current?.id);
  if (current?.id !== trackedId) {
    setTrackedId(current?.id);
    setCorrecting(false);
    setDrafts(draftsFor(current));
  }

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
  }, []);

  const grade = useCallback(
    (decision: "approved" | "corrected" | "rejected", fieldGrades?: FieldGrade[]) => {
      if (!current) return;
      startTransition(async () => {
        try {
          const m = await submitGrade({
            contactId: current.id,
            module,
            batchId,
            decision,
            fieldGrades,
          });
          if (m) setMetrics(m);
          advance();
          if (m?.status === "failed") toast.error("Batch gate FAILED — error rate over threshold.");
          else if (m?.status === "passed") toast.success("Batch gate PASSED.");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Grade failed.");
        }
      });
    },
    [current, module, batchId, advance],
  );

  const saveCorrection = useCallback(() => {
    if (!current) return;
    const fieldGrades: FieldGrade[] = [];
    for (const f of fields) {
      const original = (current[f.prop] as string | null) ?? "";
      const next = (drafts[f.field] ?? "").trim();
      if (next !== original.trim()) {
        fieldGrades.push({
          field: f.field,
          verdict: original.trim() ? "wrong" : "missing",
          correction: next || null,
          previousValue: original || null,
        });
      }
    }
    if (!fieldGrades.length) {
      toast.message("No changes — use Approve if the record is correct.");
      return;
    }
    grade("corrected", fieldGrades);
  }, [current, fields, drafts, grade]);

  // Keyboard shortcuts (ignored while typing in an input/textarea).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (pending) return;
      if (e.key === "a") grade("approved");
      else if (e.key === "r") grade("rejected");
      else if (e.key === "c") setCorrecting((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade, pending]);

  const done = index >= contacts.length;

  return (
    <div className="flex flex-col gap-4">
      {/* Gate header */}
      <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
        <Badge variant={statusVariant(metrics.status)}>gate: {metrics.status}</Badge>
        <span className="text-muted-foreground">
          graded {metrics.gradedCount}/{metrics.sampleSize}
        </span>
        <span className="text-muted-foreground">
          errors {metrics.errorCount} ({(metrics.errorRate * 100).toFixed(0)}%)
        </span>
        <span className="text-muted-foreground">
          threshold {(metrics.threshold * 100).toFixed(0)}%
        </span>
        <span className="ml-auto text-muted-foreground">
          {done ? "queue complete" : `${index + 1} of ${contacts.length}`}
        </span>
      </div>

      {done ? (
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm">
            Graded everything in this batch.{" "}
            {metrics.status === "passed"
              ? "It passed — its records can now advance to enrichment/drafting."
              : metrics.status === "failed"
                ? "It failed — revise the prompt and re-run rather than advancing."
                : "Gate still open (sample not yet sufficient)."}
          </p>
          <div className="flex gap-2">
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
              </div>
              <div className="flex items-center gap-2">
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
                {fields.map((f) =>
                  f.long ? (
                    <label key={f.field} className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">{f.label}</span>
                      <Textarea
                        value={drafts[f.field] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                        rows={3}
                      />
                    </label>
                  ) : (
                    <label key={f.field} className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">{f.label}</span>
                      <Input
                        value={drafts[f.field] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [f.field]: e.target.value }))}
                      />
                    </label>
                  ),
                )}
                <div className="flex gap-2">
                  <Button size="sm" disabled={pending} onClick={saveCorrection}>
                    Save corrections
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDrafts(draftsFor(current));
                      setCorrecting(false);
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
              <Button variant="outline" disabled={pending} onClick={() => setCorrecting((v) => !v)}>
                <Pencil className="size-4" /> Correct <kbd className="ml-1 text-xs opacity-70">c</kbd>
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => grade("rejected")}>
                <X className="size-4" /> Reject <kbd className="ml-1 text-xs opacity-70">r</kbd>
              </Button>
            </div>
          </div>
        )
      )}
      <p className="text-xs text-muted-foreground">
        Shortcuts: <kbd>a</kbd> approve · <kbd>c</kbd> correct · <kbd>r</kbd> reject. Corrections are
        recorded as eval-set pairs and written back to the contact.
      </p>
    </div>
  );
}
