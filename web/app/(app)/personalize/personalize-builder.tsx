"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import type { PersonalizationContact } from "@/lib/modules/personalization";
import { startRun, submitRunOutput } from "@/lib/runs/actions";
import type { IngestOutcome } from "@/lib/modules/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Hook research runs, copy-paste executor. Same shape as the Draft builder:
// pick a track and batch size, start a tracked run, paste the prompt into
// Claude/ChatGPT with web search ON, bring the JSON back. Ingest samples hooks
// for verification — the queue below consumes them before drafting ever sees
// a hook.

type Track = "msp" | "customer";

const clampSize = (n: number, max: number) =>
  Math.max(1, Math.min(Number.isFinite(n) ? Math.round(n) : 1, Math.max(1, max)));

export function PersonalizeBuilder({
  msp,
  customer,
}: {
  msp: PersonalizationContact[];
  customer: PersonalizationContact[];
}) {
  const router = useRouter();
  const [json, setJson] = useState("");
  const [outcome, setOutcome] = useState<IngestOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  // Run state: once started, we hold the run id + rendered prompt and reveal
  // the paste box. A second "Start run" resets and opens a fresh run.
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  // Two campaigns share this page: MSP acquisition targets and MSP customers
  // need different hook framing, so a batch never mixes them. organizations.kind
  // is tri-state ('msp' | 'customer' | 'unknown', the legacy default): unknowns
  // ride the customer track, same rule as the Draft page.
  const [track, setTrackState] = useState<Track>(customer.length ? "customer" : "msp");
  const trackContacts = track === "msp" ? msp : customer;
  const trackLabel = track === "msp" ? "target-company" : "customer";

  const [size, setSize] = useState(20);

  // Switching audience re-clamps the batch size, so the input never sits above
  // its own max showing a number the generated prompt doesn't use.
  function setTrack(next: Track) {
    setTrackState(next);
    const len = (next === "msp" ? msp : customer).length;
    setSize((s) => clampSize(s, len || 1));
  }

  const effSize = clampSize(size, trackContacts.length || 1);
  const batch = useMemo(() => trackContacts.slice(0, effSize), [trackContacts, effSize]);

  function start() {
    startTransition(async () => {
      try {
        const created = await startRun({
          module: "personalization",
          label: `Hooks · ${trackLabel} · ${batch.length} contact(s)`,
          config: { track, contacts: batch },
        });
        setRunId(created.runId);
        setPrompt(created.prompt);
        setJson("");
        setOutcome(null);
        await navigator.clipboard.writeText(created.prompt).catch(() => {});
        toast.success(
          "Run started and prompt copied. Paste into Claude/ChatGPT with web search on, then bring the JSON back.",
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not start run.");
      }
    });
  }

  function ingest() {
    if (!runId) return;
    if (!json.trim()) {
      toast.error("Paste the hooks JSON first.");
      return;
    }
    startTransition(async () => {
      try {
        const r = await submitRunOutput({ runId, rawText: json });
        setOutcome(r);
        if (r.ok) {
          toast.success(
            `Imported ${r.inserted} hook(s) — ${r.sampledCount} sampled for verification.`,
          );
          // Surface the fresh sampled hooks in the verify queue below.
          router.refresh();
        } else {
          toast.error("Import failed — see details.");
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unexpected error.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card data-tour="personalize-builder">
        <CardHeader>
          <CardTitle>1. Start a hook research run</CardTitle>
          <CardDescription>
            {`Starts a tracked run over the first ${batch.length} of ${trackContacts.length} ${trackLabel} contact(s) without a usable hook. The model must cite a source per claim — or return an honest "no hook" with a fallback angle, which is a valid outcome, never a failure.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-4 rounded-md border bg-muted/40 px-3 py-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Audience</Label>
              <div className="flex gap-1">
                <Button
                  variant={track === "msp" ? "default" : "outline"}
                  size="sm"
                  disabled={msp.length === 0}
                  onClick={() => setTrack("msp")}
                >
                  Target companies ({msp.length})
                </Button>
                <Button
                  variant={track === "customer" ? "default" : "outline"}
                  size="sm"
                  disabled={customer.length === 0}
                  onClick={() => setTrack("customer")}
                >
                  Customers ({customer.length})
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hook-batch-size" className="text-xs text-muted-foreground">
                Contacts in this batch
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="hook-batch-size"
                  type="number"
                  min={1}
                  max={trackContacts.length}
                  value={size}
                  onChange={(e) =>
                    setSize(clampSize(Number(e.target.value), trackContacts.length))
                  }
                  className="w-24"
                />
                <div className="flex gap-1">
                  {[5, 10, 15, 20].map((n) => (
                    <Button
                      key={n}
                      variant="ghost"
                      size="sm"
                      className="px-2 text-muted-foreground"
                      onClick={() => setSize(clampSize(n, trackContacts.length))}
                    >
                      {n}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div>
            <Button onClick={start} disabled={pending || trackContacts.length === 0}>
              {runId ? "Start new run" : "Start run"}
            </Button>
          </div>
          {runId && (
            <>
              <Textarea readOnly value={prompt} rows={12} className="font-mono text-xs" />
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(prompt);
                    toast.success("Prompt copied.");
                  }}
                >
                  Copy prompt again
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {runId && (
        <Card>
          <CardHeader>
            <CardTitle>2. Paste the hooks JSON</CardTitle>
            <CardDescription>
              Bring back the JSON and import it. A sample lands in the verify queue below —
              drafting consumes hooks only after the batch clears its gate.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              placeholder="Paste the full JSON object the model returned…"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={10}
              className="font-mono text-xs"
            />
            <div>
              {/* A run ingests exactly once — after a successful import the
                  button stays down until "Start new run" resets the outcome. */}
              <Button onClick={ingest} disabled={pending || !!outcome?.ok}>
                {pending ? "Importing…" : outcome?.ok ? "Imported" : "Import hooks"}
              </Button>
            </div>
            {outcome && (
              <div className="flex flex-col gap-2 text-sm">
                {outcome.ok ? (
                  <p>
                    Imported <strong>{outcome.inserted}</strong> hook(s) ·{" "}
                    <strong>{outcome.sampledCount}</strong> sampled for verification ·{" "}
                    <strong>{outcome.rejected}</strong> dropped.
                  </p>
                ) : (
                  <p className="text-destructive">{outcome.error}</p>
                )}
                {outcome.messages.map((m, i) => (
                  <p key={i} className="text-muted-foreground">
                    {m}
                  </p>
                ))}
                {outcome.ok && (
                  <div className="flex gap-2">
                    {outcome.sampledCount > 0 ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          router.refresh();
                          document
                            .getElementById("verify-queue")
                            ?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        Verify sampled hooks ↓
                      </Button>
                    ) : (
                      <Button size="sm" nativeButton={false} render={<Link href="/draft" />}>
                        Draft messages (step 5) →
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
