"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  saveFramingCopy,
  resetFramingBlock,
  type FramingCopy,
  type FramingKey,
} from "@/lib/workspace/admin-actions";

// The prose around the worked examples: who the recipient is, what to credit
// them on, and what a subject line looks like.
//
// These used to be migration-only, which meant a tenant whose angles described
// the wrong job had no way to fix them. That is worse than it sounds — a wrong
// angle is not vague, it is a confident sentence about the recipient's work that
// happens to be untrue, and it sits directly above the rule telling the model
// not to invent things.

const FIELDS: { key: FramingKey; label: string; hint: string }[] = [
  {
    key: "personaAnglesCustomer",
    label: "Persona angles — customers",
    hint: "What each kind of recipient at a customer actually cares about. One line per persona key (owner, head_of_it, other).",
  },
  {
    key: "personaAnglesMsp",
    label: "Persona angles — target companies",
    hint: "The same, for people who run the firms you may acquire.",
  },
  {
    key: "personaAnglesAdvisor",
    label: "Persona angles — referral partners",
    hint: "The same, for firms that advise your targets. The persona keys are schema literals here: read owner as a principal of the practice and head_of_it as someone below that, not as job functions.",
  },
  {
    key: "perspectiveCustomer",
    label: "Credit their perspective on — customers",
    hint: "Completes “credit their perspective on …”. A phrase, not a sentence.",
  },
  {
    key: "perspectiveMsp",
    label: "Credit their perspective on — target companies",
    hint: "The same, from the operator's side.",
  },
  {
    key: "perspectiveAdvisor",
    label: "Credit their perspective on — referral partners",
    hint: "The same, from the adviser's side of the relationship.",
  },
  {
    key: "subjectShapesCustomer",
    label: "Subject-line shapes — customers",
    hint: "Examples of the shape a subject should take, not lines to reuse verbatim.",
  },
  {
    key: "subjectShapesMsp",
    label: "Subject-line shapes — target companies",
    hint: "The same, for outreach to operators.",
  },
  {
    key: "subjectShapesAdvisor",
    label: "Subject-line shapes — referral partners",
    hint: "The same, for outreach that proposes a referral relationship rather than research.",
  },
];

export function FramingPanel({
  copy,
  defaults,
  overridden,
  isAdmin,
}: {
  copy: FramingCopy;
  defaults: FramingCopy;
  /** Blocks this workspace has actually changed, as opposed to inherited. */
  overridden: FramingKey[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fields, setFields] = useState<FramingCopy>(copy);

  const isOwn = (key: FramingKey) => overridden.includes(key);
  const dirty = FIELDS.some((f) => fields[f.key].trim() !== copy[f.key].trim());

  function save() {
    // Send only what changed: an unedited field stays inherited rather than
    // being frozen as an override of the same text, which would then stop
    // tracking any future change to the default.
    const changed: Partial<FramingCopy> = {};
    for (const f of FIELDS) {
      if (fields[f.key].trim() !== copy[f.key].trim()) changed[f.key] = fields[f.key];
    }
    if (!Object.keys(changed).length) return;
    start(async () => {
      try {
        await saveFramingCopy(changed);
        toast.success(
          `Saved. New drafting runs will use ${
            Object.keys(changed).length === 1 ? "this block" : "these blocks"
          }; runs already started keep the prompt they were created with.`,
        );
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  function reset(key: FramingKey) {
    start(async () => {
      try {
        await resetFramingBlock(key);
        setFields((f) => ({ ...f, [key]: defaults[key] }));
        toast.success("Restored the built-in wording.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not reset.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Message framing</CardTitle>
        <CardDescription>
          The prose the drafting prompt carries around your worked examples: who the recipient is,
          what to credit them on, and what a subject line should look like. Vocabulary alone
          can&rsquo;t fix these — they describe a job, not a word.{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {"{{firmName}}"}
          </code>{" "}
          and the other tokens resolve when the prompt renders.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={f.key} className="text-sm font-medium">
                {f.label}
              </Label>
              {isOwn(f.key) ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">yours</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || !isAdmin}
                    onClick={() => reset(f.key)}
                  >
                    Reset
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">built-in default</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{f.hint}</p>
            <Textarea
              id={f.key}
              rows={f.key.startsWith("perspective") ? 2 : 6}
              className="font-mono text-xs"
              value={fields[f.key]}
              disabled={!isAdmin}
              onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
            />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={pending || !isAdmin || !dirty}>
            {pending ? "Saving…" : "Save framing"}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setFields(copy)}
            >
              Discard changes
            </Button>
          )}
          {!isAdmin && (
            <span className="text-xs text-muted-foreground">
              Admins can edit these. You can read them.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
