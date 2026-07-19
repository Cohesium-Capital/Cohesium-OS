"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  buildDraftPrompt,
  buildDraftAgentPrompt,
  type DraftContact,
  type TrackKind,
} from "@/lib/drafting/prompt";
import { importDrafts } from "@/lib/drafting/import";
import type { DraftReport } from "@/lib/drafting/types";
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
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<DraftReport | null>(null);

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

  // Switching audience re-clamps the batch size, so the input never sits above
  // its own max showing a number the generated prompt doesn't use.
  function setTrack(next: TrackKind) {
    setTrackState(next);
    const len = (next === "msp" ? mspContacts : customerContacts).length;
    setSize((s) => clampSize(s, len || 1));
  }
  const trackLabel = track === "msp" ? "MSP-target" : "customer";

  const effSize = clampSize(size, trackContacts.length || 1);
  const batch = useMemo(() => trackContacts.slice(0, effSize), [trackContacts, effSize]);
  const prompt = useMemo(
    () =>
      mode === "single"
        ? buildDraftPrompt(batch, track)
        : buildDraftAgentPrompt(trackContacts, effSize, track),
    [mode, batch, trackContacts, effSize, track],
  );
  const chunks = Math.max(1, Math.ceil(trackContacts.length / effSize));

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    toast.success(
      mode === "single"
        ? "Prompt copied. Paste into Claude/ChatGPT with web search on, then bring the JSON back."
        : "Prompt copied. Run it in Claude Code, then paste the JSON it returns below.",
    );
  }

  async function run() {
    if (!json.trim()) {
      toast.error("Paste the drafts JSON first.");
      return;
    }
    setLoading(true);
    setReport(null);
    try {
      const r = await importDrafts(json);
      setReport(r);
      if (r.ok) toast.success(`Queued ${r.drafted} new, updated ${r.updated} draft(s).`);
      else toast.error("Import failed — see details.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Draft</h1>
          <p className="text-sm text-muted-foreground">
            Generate per-persona messages, then queue them for review.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/draft/queue" />}>
          View queue →
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Copy the drafting prompt</CardTitle>
          <CardDescription>
            {contacts.length === 0
              ? "No contacts with an email or LinkedIn yet."
              : mode === "single"
                ? `Generates a prompt for the first ${batch.length} of ${trackContacts.length} ${trackLabel} contact(s). Paste it into Claude/ChatGPT with web search on, bring the JSON back, then repeat for the next batch.`
                : `Hands all ${trackContacts.length} ${trackLabel} contact(s) to Claude Code, which fans them out to ${chunks} subagent(s) of up to ${effSize} each, then returns one combined JSON.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Run enrichment first.</p>
          ) : (
            <>
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
                      MSP targets ({mspContacts.length})
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
              <Textarea readOnly value={prompt} rows={14} className="font-mono text-xs" />
              <div>
                <Button onClick={copyPrompt}>Copy prompt</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Paste the drafts JSON</CardTitle>
          <CardDescription>
            Bring back the JSON and import it. Drafts queue as planned touches you can
            review and edit.
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
            <Button onClick={run} disabled={loading}>
              {loading ? "Importing…" : "Import drafts"}
            </Button>
          </div>
          {report && (
            <div className="flex flex-col gap-2 text-sm">
              {report.ok ? (
                <p>
                  Queued <strong>{report.drafted}</strong> new, updated{" "}
                  <strong>{report.updated}</strong>. Skipped {report.skippedNoAddress} (no
                  address) · {report.skippedUnknown} (unknown contact).
                </p>
              ) : (
                <p className="text-destructive">{report.error}</p>
              )}
              {report.messages.map((m, i) => (
                <p key={i} className="text-muted-foreground">
                  {m}
                </p>
              ))}
              {report.ok && report.drafted + report.updated > 0 && (
                <div>
                  <Button size="sm" nativeButton={false} render={<Link href="/draft/queue" />}>
                    Review & send (step 5) →
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
