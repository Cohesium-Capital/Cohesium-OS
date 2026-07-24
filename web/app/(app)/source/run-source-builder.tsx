"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { type Msp, type SourcingMode } from "@/lib/sourcing/prompts";
import { startRun, submitRunOutput } from "@/lib/runs/actions";
import type { IngestOutcome } from "@/lib/modules/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODE_LABELS: Record<SourcingMode, string> = {
  research_msps: "Research MSPs (find acquisition targets)",
  research_customers: "Research customers (then estimate their MSP)",
  find_customers_for_msps: "Find customers for specific MSPs",
};

function parseMspLines(text: string): Msp[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, domain] = line.split(/[,\t]/).map((s) => s?.trim());
      return { name, domain: domain || null };
    })
    .filter((m) => m.name);
}

type Outcome = IngestOutcome & { batchId?: string | null };

export function RunSourceBuilder({
  msps,
  initialMspId,
}: {
  msps: Msp[];
  initialMspId: string | null;
}) {
  const [mode, setMode] = useState<SourcingMode>(
    initialMspId ? "find_customers_for_msps" : "research_msps",
  );
  const [region, setRegion] = useState("");
  const [profile, setProfile] = useState("");
  const [count, setCount] = useState(25);
  const [countPer, setCountPer] = useState(10);
  const [selected, setSelected] = useState<Record<string, boolean>>(
    initialMspId ? { [initialMspId]: true } : {},
  );
  const [extraMsps, setExtraMsps] = useState("");

  // Run state: once started, we hold the run id + rendered prompt and reveal the
  // paste box. A second "Start run" resets and opens a fresh batch.
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [json, setJson] = useState("");
  const [strict, setStrict] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const pickedFromList = useMemo(
    () => msps.filter((m) => m.id && selected[m.id]),
    [msps, selected],
  );
  const chosenMsps = useMemo<Msp[]>(
    () => [...pickedFromList, ...parseMspLines(extraMsps)],
    [pickedFromList, extraMsps],
  );

  const kind = mode === "research_msps" ? "msp" : "customer";
  const targetMspId =
    mode === "find_customers_for_msps" && pickedFromList.length === 1
      ? pickedFromList[0].id ?? null
      : null;

  function start() {
    startTransition(async () => {
      try {
        const label = `${kind === "msp" ? "MSPs" : "Customers"} · ${mode.replace(/_/g, " ")}`;
        const created = await startRun({
          module: "sourcing",
          label,
          config: { mode, region, profile, count, countPer, msps: chosenMsps, kind, targetMspId },
        });
        setRunId(created.runId);
        setPrompt(created.prompt);
        setJson("");
        setOutcome(null);
        await navigator.clipboard.writeText(created.prompt).catch(() => {});
        toast.success("Run started and prompt copied. Paste it into Claude/ChatGPT with web search on.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not start run.");
      }
    });
  }

  function ingest() {
    if (!runId) return;
    if (!json.trim()) {
      toast.error("Paste the JSON the model returned first.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await submitRunOutput({ runId, rawText: json, requireEvidence: strict });
        setOutcome(result);
        if (result.ok) toast.success(`Imported ${result.inserted} contact(s).`);
        else toast.error("Import failed — see details below.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unexpected error.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Source</h1>
          <p className="text-sm text-muted-foreground">
            Start a run, paste the prompt into Claude/ChatGPT, then drop the JSON back here. Each
            run opens a tracked, gradeable batch.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" nativeButton={false} render={<Link href="/source/import" />}>
            Import CSV / paste manually
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
            All runs →
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Configure</CardTitle>
          <CardDescription>Pick a mode and narrow the target.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as SourcingMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABELS) as SourcingMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="region">Region</Label>
              <Input
                id="region"
                placeholder="e.g. Texas, or Austin TX metro"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="count">
                {mode === "find_customers_for_msps" ? "Customers per MSP" : "How many"}
              </Label>
              <Input
                id="count"
                type="number"
                min={1}
                value={mode === "find_customers_for_msps" ? countPer : count}
                onChange={(e) =>
                  mode === "find_customers_for_msps"
                    ? setCountPer(Number(e.target.value))
                    : setCount(Number(e.target.value))
                }
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="profile">Target profile (optional)</Label>
            <Input
              id="profile"
              placeholder="e.g. 20-100 employee professional services firms"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            />
          </div>

          {mode === "find_customers_for_msps" && (
            <div className="grid gap-3">
              <Label>Target MSPs</Label>
              {msps.length > 0 && (
                <div className="flex max-h-64 flex-col gap-2 overflow-auto rounded-md border p-3">
                  {msps.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={!!(m.id && selected[m.id])}
                        onCheckedChange={(c) =>
                          m.id && setSelected((s) => ({ ...s, [m.id!]: !!c }))
                        }
                      />
                      <span>
                        {m.name}
                        {m.domain ? <span className="text-muted-foreground"> · {m.domain}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <Textarea
                placeholder="Add more MSPs, one per line: Name, domain.com"
                value={extraMsps}
                onChange={(e) => setExtraMsps(e.target.value)}
                rows={3}
              />
            </div>
          )}

          <div>
            <Button onClick={start} disabled={pending}>
              {runId ? "Start new run" : "Start run"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {runId && (
        <Card>
          <CardHeader>
            <CardTitle>2. Run it, then paste the JSON</CardTitle>
            <CardDescription>
              The prompt is copied to your clipboard. Run it in Claude/ChatGPT with web search on,
              then paste the JSON object back here.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea readOnly value={prompt} rows={8} className="font-mono text-xs" />
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

            <Textarea
              placeholder='{ "organizations": [ ... ] }'
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={12}
              className="font-mono text-xs"
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={strict} onCheckedChange={(v) => setStrict(!!v)} />
              Strict: drop rows with no source URL (logged to rejected, not imported)
            </label>
            <div>
              <Button onClick={ingest} disabled={pending}>
                {pending ? "Importing…" : "Import results"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {outcome && (
        <Card>
          <CardHeader>
            <CardTitle>{outcome.ok ? "Imported" : "Import failed"}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {outcome.ok ? (
              <>
                <p>
                  <strong>{outcome.inserted}</strong> contact(s) imported ·{" "}
                  <strong>{outcome.sampledCount}</strong> sampled for grading ·{" "}
                  <strong>{outcome.rejected}</strong> dropped.
                </p>
                {outcome.messages.map((m, i) => (
                  <p key={i} className="text-muted-foreground">
                    {m}
                  </p>
                ))}
                <div className="flex gap-2 pt-1">
                  {outcome.batchId && (
                    <Button
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/review/grade?batch=${outcome.batchId}`} />}
                    >
                      Grade this batch
                    </Button>
                  )}
                  <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/review" />}>
                    Go to Review
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-destructive">{outcome.error}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
