"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { buildPrompt, type Msp, type SourcingMode } from "@/lib/sourcing/prompts";
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

// Parse free-text "name" or "name, domain" lines into MSPs.
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

export function PromptBuilder({
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

  const pickedFromList = useMemo(
    () => msps.filter((m) => m.id && selected[m.id]),
    [msps, selected],
  );

  const chosenMsps = useMemo<Msp[]>(
    () => [...pickedFromList, ...parseMspLines(extraMsps)],
    [pickedFromList, extraMsps],
  );

  // If exactly one known MSP is targeted, carry it to Import so the run is
  // attributed and yield tracking works.
  const importHref =
    mode === "find_customers_for_msps" && pickedFromList.length === 1
      ? `/source/import?target=${pickedFromList[0].id}`
      : "/source/import";

  const prompt = useMemo(
    () =>
      buildPrompt({ mode, region, profile, count, countPer, msps: chosenMsps }),
    [mode, region, profile, count, countPer, chosenMsps],
  );

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    toast.success("Prompt copied. Paste it into Claude or ChatGPT with web search on.");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Source</h1>
          <p className="text-sm text-muted-foreground">
            Build a research prompt, run it in Claude/ChatGPT, then import the JSON.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href={importHref} />}>
          Import results →
        </Button>
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
                        {m.domain ? (
                          <span className="text-muted-foreground"> · {m.domain}</span>
                        ) : null}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Copy the prompt</CardTitle>
          <CardDescription>
            Paste into Claude or ChatGPT with web search enabled, then bring the JSON
            back to Import.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea readOnly value={prompt} rows={14} className="font-mono text-xs" />
          <div>
            <Button onClick={copyPrompt}>Copy prompt</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
