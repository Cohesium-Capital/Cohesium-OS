"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { DraftContact, TrackKind } from "@/lib/drafting/prompt";
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

type Mode = "single" | "agent";

const clampSize = (n: number, max: number) =>
  Math.max(1, Math.min(Number.isFinite(n) ? Math.round(n) : 1, Math.max(1, max)));

export function DraftBuilder({ contacts }: { contacts: DraftContact[] }) {
  const [json, setJson] = useState("");
  const [outcome, setOutcome] = useState<IngestOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  // Run state: once started, we hold the run id + rendered prompt and reveal the
  // paste box. A second "Start run" resets and opens a fresh run.
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  // How to hand the work off:
  // - "single": one focused batch of `size` contacts you paste into a chat. Best
  //   quality per message; you repeat for the next batch.
  // - "agent": hand the whole list to Claude Code, which fans it out to subagents
  //   of `size` contacts each. Faster for big lists; tune `size` down if quality
  //   slips.
  const [mode, setMode] = useState<Mode>("single");
  const [size, setSize] = useState(20);

  // Two campaigns share this page: MSP acquisition targets and MSP customers
  // need different framing, so a batch never mixes them. organizations.kind is
  // tri-state ('msp' | 'customer' | 'unknown', the legacy default): unknowns
  // ride the customer track, which keeps the original framing — reclassify the
  // org if that's wrong.
  const mspContacts = useMemo(
    () => contacts.filter((c) => c.org_kind === "msp"),
    [contacts],
  );
  const customerContacts = useMemo(
    () => contacts.filter((c) => c.org_kind !== "msp"),
    [contacts],
  );
  const [track, setTrackState] = useState<TrackKind>(
    customerContacts.length ? "customer" : "msp",
  );
  const trackContacts = track === "msp" ? mspContacts : customerContacts;

  // Hook coverage for the selected track. Contacts arrive with their latest
  // usable hook already resolved server-side; kind='none' rows are the honest
  // "no hook exists" outcome and carry a fallback angle instead of a claim.
  // Drafting without either stays allowed — the no-hook arm is the rent
  // check's control group, so coverage informs the operator, never blocks.
  const hooked = trackContacts.filter(
    (c) => c.hook_id && c.hook_kind !== "none",
  ).length;
  const fallbacks = trackContacts.filter((c) => c.hook_kind === "none").length;

  // Switching audience re-clamps the batch size, so the input never sits above
  // its own max showing a number the generated prompt doesn't use.
  function setTrack(next: TrackKind) {
    setTrackState(next);
    const len = (next === "msp" ? mspContacts : customerContacts).length;
    setSize((s) => clampSize(s, len || 1));
  }
  const trackLabel = track === "msp" ? "target-company" : "customer";

  const effSize = clampSize(size, trackContacts.length || 1);
  const batch = useMemo(() => trackContacts.slice(0, effSize), [trackContacts, effSize]);
  const chunks = Math.max(1, Math.ceil(trackContacts.length / effSize));

  function start() {
    startTransition(async () => {
      try {
        // Single mode drafts the front batch; agent mode hands over the whole
        // track and lets Claude Code chunk it.
        const runContacts = mode === "single" ? batch : trackContacts;
        const created = await startRun({
          module: "drafting",
          label: `Drafts · ${trackLabel} · ${runContacts.length} contact(s)`,
          config: { track, mode, chunkSize: effSize, contacts: runContacts },
        });
        setRunId(created.runId);
        setPrompt(created.prompt);
        setJson("");
        setOutcome(null);
        await navigator.clipboard.writeText(created.prompt).catch(() => {});
        toast.success(
          mode === "single"
            ? "Run started and prompt copied. Paste into Claude/ChatGPT (no web search needed — hooks are pre-verified), then bring the JSON back."
            : "Run started and prompt copied. Run it in Claude Code, then paste the JSON it returns below.",
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not start run.");
      }
    });
  }

  function ingest() {
    if (!runId) return;
    if (!json.trim()) {
      toast.error("Paste the drafts JSON first.");
      return;
    }
    startTransition(async () => {
      try {
        const r = await submitRunOutput({ runId, rawText: json });
        setOutcome(r);
        if (r.ok) toast.success(`Imported ${r.inserted} draft(s) — approve them in the queue.`);
        else toast.error("Import failed — see details.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unexpected error.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Draft</h1>
          <p className="text-sm text-muted-foreground">
            Turn researched hooks into per-persona messages, then queue them for review.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/draft/queue" />}>
          View queue →
        </Button>
      </div>

      <Card data-tour="draft-builder">
        <CardHeader>
          <CardTitle>1. Start a drafting run</CardTitle>
          <CardDescription>
            {contacts.length === 0
              ? "No contacts with an email or LinkedIn yet."
              : mode === "single"
                ? `Starts a tracked run over the first ${batch.length} of ${trackContacts.length} ${trackLabel} contact(s). Paste the prompt into Claude/ChatGPT, bring the JSON back, then repeat for the next batch. Hooks are pre-verified — drafting is pure writing, no web search.`
                : `Starts a tracked run handing all ${trackContacts.length} ${trackLabel} contact(s) to Claude Code, which fans them out to ${chunks} subagent(s) of up to ${effSize} each, then returns one combined JSON.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Run enrichment first.</p>
          ) : (
            <>
              {/* Coverage, not a gate: hookless contacts still draft (control
                  arm), but the operator sees when researching first is worth it. */}
              <p data-tour="draft-coverage" className="text-xs text-muted-foreground">
                {hooked} of {trackContacts.length} {trackLabel} contact(s) have a
                verified hook
                {fallbacks > 0 && `, ${fallbacks} an honest fallback angle`}; the rest
                open with a plain role/industry observation (the no-hook control arm).
                To research hooks first, use{" "}
                <Link
                  href="/personalize"
                  className="text-foreground underline underline-offset-2"
                >
                  Personalize (step 4)
                </Link>
                .
              </p>
              <div className="flex flex-wrap items-end gap-4 rounded-md border bg-muted/40 px-3 py-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Audience</Label>
                  <div className="flex gap-1">
                    <Button
                      variant={track === "msp" ? "default" : "outline"}
                      size="sm"
                      disabled={mspContacts.length === 0}
                      onClick={() => setTrack("msp")}
                    >
                      Target companies ({mspContacts.length})
                    </Button>
                    <Button
                      variant={track === "customer" ? "default" : "outline"}
                      size="sm"
                      disabled={customerContacts.length === 0}
                      onClick={() => setTrack("customer")}
                    >
                      Customers ({customerContacts.length})
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Mode</Label>
                  <div className="flex gap-1">
                    <Button
                      variant={mode === "single" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setMode("single")}
                    >
                      Single batch (chat)
                    </Button>
                    <Button
                      variant={mode === "agent" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setMode("agent")}
                    >
                      Fan out (Claude Code)
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="size" className="text-xs text-muted-foreground">
                    {mode === "single" ? "Contacts in this batch" : "Contacts per subagent"}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="size"
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
                <Button onClick={start} disabled={pending}>
                  {runId ? "Start new run" : "Start run"}
                </Button>
              </div>
              {runId && (
                <>
                  <Textarea readOnly value={prompt} rows={14} className="font-mono text-xs" />
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
            </>
          )}
        </CardContent>
      </Card>

      {runId && (
        <Card>
          <CardHeader>
            <CardTitle>2. Paste the drafts JSON</CardTitle>
            <CardDescription>
              Bring back the JSON and import it. Drafts queue as planned touches — every one
              starts unapproved and sends only after you approve it in the queue.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              placeholder='{ "drafts": [ ... ] }'
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={10}
              className="font-mono text-xs"
            />
            <div>
              <Button onClick={ingest} disabled={pending}>
                {pending ? "Importing…" : "Import drafts"}
              </Button>
            </div>
            {outcome && (
              <div className="flex flex-col gap-2 text-sm">
                {outcome.ok ? (
                  <p>
                    Queued <strong>{outcome.inserted}</strong> draft(s) for review — they
                    start unapproved.
                  </p>
                ) : (
                  <p className="text-destructive">{outcome.error}</p>
                )}
                {outcome.messages.map((m, i) => (
                  <p key={i} className="text-muted-foreground">
                    {m}
                  </p>
                ))}
                {outcome.ok && outcome.inserted > 0 && (
                  <div>
                    <Button size="sm" nativeButton={false} render={<Link href="/draft/queue" />}>
                      Review & approve (step 6) →
                    </Button>
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
