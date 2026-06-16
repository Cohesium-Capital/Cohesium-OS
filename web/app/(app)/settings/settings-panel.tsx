"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  updateGateSettings,
  activatePromptVersion,
  addPromptVersion,
} from "@/lib/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type ModuleSettings = {
  module: string;
  gate_threshold: number;
  sample_rate: number;
  min_sample_size: number;
};

export type PromptVersion = {
  id: string;
  module: string;
  version: number;
  prompt: string;
  notes: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
};

export function SettingsPanel({
  settings,
  prompts,
}: {
  settings: ModuleSettings[];
  prompts: PromptVersion[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Eval gates</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {settings.map((s) => (
            <GateCard key={s.module} settings={s} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Prompt versions</h2>
        {[...new Set(prompts.map((p) => p.module))].map((module) => (
          <PromptModule
            key={module}
            module={module}
            versions={prompts.filter((p) => p.module === module)}
          />
        ))}
        {prompts.length === 0 && (
          <p className="text-sm text-muted-foreground">No prompt versions seeded yet.</p>
        )}
      </section>
    </div>
  );
}

function GateCard({ settings }: { settings: ModuleSettings }) {
  const [pending, startTransition] = useTransition();
  const [threshold, setThreshold] = useState(settings.gate_threshold);
  const [sample, setSample] = useState(settings.sample_rate);
  const [minSize, setMinSize] = useState(settings.min_sample_size);

  function save() {
    startTransition(async () => {
      try {
        await updateGateSettings({
          module: settings.module,
          gateThreshold: threshold,
          sampleRate: sample,
          minSampleSize: minSize,
        });
        toast.success(`${settings.module} gate updated.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Update failed.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="capitalize">{settings.module}</CardTitle>
        <CardDescription>
          Records advance once a graded sample clears the error threshold.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">Error threshold</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Sample rate</Label>
            <Input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={sample}
              onChange={(e) => setSample(Number(e.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Min sample</Label>
            <Input
              type="number"
              min={1}
              value={minSize}
              onChange={(e) => setMinSize(Number(e.target.value))}
            />
          </div>
        </div>
        <div>
          <Button size="sm" onClick={save} disabled={pending}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PromptModule({ module, versions }: { module: string; versions: PromptVersion[] }) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const active = versions.find((v) => v.active);
  const [draft, setDraft] = useState(active?.prompt ?? "");
  const [notes, setNotes] = useState("");

  function activate(id: string) {
    startTransition(async () => {
      try {
        await activatePromptVersion({ id, module });
        toast.success("Activated.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed.");
      }
    });
  }

  function add() {
    if (!draft.trim()) {
      toast.error("Prompt is empty.");
      return;
    }
    startTransition(async () => {
      try {
        await addPromptVersion({ module, prompt: draft, notes: notes || null });
        toast.success("New version saved and activated.");
        setAdding(false);
        setNotes("");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 capitalize">
          {module}
          {active && <Badge variant="secondary">v{active.version} active</Badge>}
        </CardTitle>
        <CardDescription>
          {versions.length} version{versions.length === 1 ? "" : "s"}. New versions are immutable
          snapshots so error rates stay comparable.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col divide-y rounded-md border">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">v{v.version}</span>
                {v.active && <Badge>active</Badge>}
                {v.notes && <span className="text-muted-foreground">{v.notes}</span>}
              </div>
              {!v.active && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => activate(v.id)}>
                  Activate
                </Button>
              )}
            </div>
          ))}
        </div>

        {adding ? (
          <div className="flex flex-col gap-2">
            <Label className="text-xs">New version prompt</Label>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              className="font-mono text-xs"
            />
            <Input
              placeholder="Notes (what changed?)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={add} disabled={pending}>
                Save new version
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(active?.prompt ?? "");
                setAdding(true);
              }}
            >
              Add version
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
