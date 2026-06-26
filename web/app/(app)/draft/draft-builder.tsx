"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { buildDraftAgentPrompt, type DraftContact } from "@/lib/drafting/prompt";
import { importDrafts } from "@/lib/drafting/import";
import type { DraftReport } from "@/lib/drafting/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Subagents draft this many contacts each. The fan-out prompt tells Claude Code
// to split the full list into chunks of this size and run one subagent per chunk.
const CHUNK = 15;

export function DraftBuilder({ contacts }: { contacts: DraftContact[] }) {
  const [json, setJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<DraftReport | null>(null);

  // Hand the whole list to Claude Code at once; the prompt fans it out to
  // subagents (chunks of CHUNK) that research + draft, then merge to one JSON.
  const prompt = useMemo(() => buildDraftAgentPrompt(contacts, CHUNK), [contacts]);
  const chunks = Math.max(1, Math.ceil(contacts.length / CHUNK));

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    toast.success("Prompt copied. Run it in Claude Code, then paste the JSON it returns below.");
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
          <CardTitle>1. Copy the Claude Code drafting prompt</CardTitle>
          <CardDescription>
            All {contacts.length} contact(s) with an address are included below. Run this in
            Claude Code — it fans the list out to {chunks} subagent(s) of up to {CHUNK} each that
            web-research and draft every contact, then return one combined JSON to paste below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contacts with an email or LinkedIn yet. Run enrichment first.
            </p>
          ) : (
            <>
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
            <div className="text-sm">
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
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
