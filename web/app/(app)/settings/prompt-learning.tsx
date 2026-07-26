"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Check, X, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  approveRule,
  dismissRule,
  dropRule,
  runLearningNow,
} from "@/lib/learning/actions";
import { formatDate } from "@/lib/format/date";

// The window onto the learning loop. Two jobs: show what the prompts have
// learned (with the edits that taught it), and make any of it reversible in one
// click. An automatic prompt-editing loop nobody can see or undo is not a
// feature, it is a liability.

export type RuleRow = {
  id: string;
  module: string;
  scope: Record<string, unknown>;
  rule_text: string;
  rationale: string | null;
  status: string;
  evidence: { signal_id?: string; before?: string | null; after?: string | null }[];
  support_count: number;
  confidence: number | null;
  source: string;
  activated_at: string | null;
  created_at: string;
};

export type LearningRunRow = {
  id: string;
  module: string;
  signals_considered: number;
  proposed: number;
  auto_activated: number;
  error: string | null;
  trigger: string;
  created_at: string;
};

export function PromptLearning({
  rules,
  runs,
  unprocessed,
  analyzerConfigured,
}: {
  rules: RuleRow[];
  runs: LearningRunRow[];
  unprocessed: number;
  analyzerConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const active = rules.filter((r) => r.status === "active");
  const proposed = rules.filter((r) => r.status === "proposed");
  const lastRun = runs[0];

  function run(fn: () => Promise<unknown>, ok: string) {
    startTransition(async () => {
      try {
        const result = await fn();
        if (Array.isArray(result)) result.forEach((line) => toast.message(String(line)));
        else toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" />
          Prompt learning
        </CardTitle>
        <CardDescription>
          Every human correction — a draft you edited, a hook you rejected, a contact you
          deleted with a reason — is collected and read for patterns. A pattern backed by at
          least three independent corrections becomes a rule appended to that stage&rsquo;s
          prompt; anything weaker waits here for your call. Rules ride the prompt version, so
          Outcomes measures whether each one actually helped.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{active.length}</span>{" "}
            <span className="text-muted-foreground">active</span>
          </span>
          <span>
            <span className="font-semibold tabular-nums">{proposed.length}</span>{" "}
            <span className="text-muted-foreground">awaiting your review</span>
          </span>
          <span>
            <span className="font-semibold tabular-nums">{unprocessed}</span>{" "}
            <span className="text-muted-foreground">corrections not yet analyzed</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={pending}
            onClick={() => run(runLearningNow, "Analysis complete.")}
          >
            Analyze now
          </Button>
        </div>

        {!analyzerConfigured && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            <strong className="text-amber-600">ANTHROPIC_API_KEY is not set.</strong>{" "}
            Corrections are still being collected and nothing is lost — they queue up and get
            analyzed the first time the key is present. Only the analysis step needs the API;
            the research prompts stay on your subscription.
          </p>
        )}

        {lastRun && (
          <p className="text-xs text-muted-foreground">
            Last pass {formatDate(lastRun.created_at)} ({lastRun.trigger}) — read{" "}
            {lastRun.signals_considered} correction(s), proposed {lastRun.proposed}, activated{" "}
            {lastRun.auto_activated}
            {lastRun.error ? ` · error: ${lastRun.error}` : ""}
          </p>
        )}

        {proposed.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Awaiting review</h3>
            {proposed.map((r) => (
              <RuleCard
                key={r.id}
                rule={r}
                expanded={expanded === r.id}
                onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run(() => approveRule(r.id), "Rule activated.")}
                    >
                      <Check className="size-4" /> Use it
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => run(() => dismissRule(r.id, reason), "Rule dismissed.")}
                    >
                      <X className="size-4" /> Dismiss
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Active in prompts</h3>
          {active.length ? (
            active.map((r) => (
              <RuleCard
                key={r.id}
                rule={r}
                expanded={expanded === r.id}
                onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                actions={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(() => dropRule(r.id, reason), "Rule retired.")}
                  >
                    <Undo2 className="size-4" /> Retire
                  </Button>
                }
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing learned yet. Edit a few drafts before sending them and the next pass will
              have something to read.
            </p>
          )}
        </div>

        <Input
          placeholder="Optional reason, recorded with a retire or dismiss…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="max-w-md"
        />
      </CardContent>
    </Card>
  );
}

function RuleCard({
  rule,
  expanded,
  onToggle,
  actions,
}: {
  rule: RuleRow;
  expanded: boolean;
  onToggle: () => void;
  actions: React.ReactNode;
}) {
  const scope = Object.entries(rule.scope ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm">{rule.rule_text}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">{rule.module}</Badge>
            {scope && <span>{scope}</span>}
            <span>
              {rule.support_count} correction{rule.support_count === 1 ? "" : "s"}
            </span>
            {rule.source === "human" && <Badge variant="secondary">written by you</Badge>}
            {rule.activated_at && <span>active since {formatDate(rule.activated_at)}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>

      {rule.rationale && (
        <p className="mt-2 text-xs text-muted-foreground">{rule.rationale}</p>
      )}

      {rule.evidence?.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {expanded ? "Hide" : "Show"} the {rule.evidence.length} edit(s) behind this
          </button>
          {expanded && (
            <div className="mt-2 flex flex-col gap-2">
              {rule.evidence.map((e, i) => (
                <div key={i} className="rounded bg-muted/50 p-2 text-xs">
                  {e.before && (
                    <p className="text-muted-foreground">
                      <span className="font-medium">before:</span> {e.before}
                    </p>
                  )}
                  {e.after && (
                    <p>
                      <span className="font-medium">after:</span> {e.after}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
