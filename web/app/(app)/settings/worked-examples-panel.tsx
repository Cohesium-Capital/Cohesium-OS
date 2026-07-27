"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  draftExamplesFromInterview,
  saveWorkedExamples,
} from "@/lib/workspace/admin-actions";

// The worked examples the drafting prompt shows the model.
//
// Three ways in, and they end in the same place: answer a few questions and let
// it assemble one, edit what is there, or paste your own. Whatever route, the
// text in the boxes below is exactly what the prompt will carry — there is no
// further processing between here and the model.
//
// The questions exist because a blank textarea is a bad way to ask for the most
// consequential prose in the system, and because generating the examples
// outright would mean a model inventing a market detail directly above a rule
// forbidding invented details. The operator supplies every specific; the model
// may only tighten the wording, and anything it adds is thrown away.

export function WorkedExamplesPanel({
  goldCustomer,
  goldMsp,
  isDefault,
  isAdmin,
}: {
  goldCustomer: string;
  goldMsp: string;
  isDefault: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);

  const [recipients, setRecipients] = useState("");
  const [curiosity, setCuriosity] = useState("");
  const [operatorTopics, setOperatorTopics] = useState("");
  const [region, setRegion] = useState("");

  const [customer, setCustomer] = useState(goldCustomer);
  const [msp, setMsp] = useState(goldMsp);
  const [notes, setNotes] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        // Saved text is no longer unsaved: without this the Save button stays
        // lit and "Discard changes" keeps offering to undo work already stored.
        setDirty(false);
        setNotes([]);
        toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  const build = () =>
    start(async () => {
      try {
        const r = await draftExamplesFromInterview({
          recipients,
          curiosity,
          operatorTopics,
          region,
        });
        setCustomer(r.goldCustomer);
        setMsp(r.goldMsp);
        setNotes(r.notes);
        setDirty(true);
        toast.success("Built from your answers — read them over before saving.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not build the examples.");
      }
    });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Worked examples</CardTitle>
        <CardDescription>
          One example message per track, shown to the model as &ldquo;imitate this voice and
          shape, never copy the facts&rdquo;. It is the single most influential piece of text in
          the drafting prompt — about one draft in eight picks up its opening frame.
          {isDefault && (
            <>
              {" "}
              <strong className="text-foreground">
                Yours are still the generic defaults.
              </strong>{" "}
              They are deliberately vague so they cannot mislead; an example written for your
              market will do considerably more work.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isAdmin && (
          <div className="rounded-md border bg-muted/30 p-3">
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-sm font-medium"
              onClick={() => setOpen((o) => !o)}
            >
              <Wand2 className="size-4" />
              Build one from a few questions
              <span className="ml-auto text-xs text-muted-foreground">
                {open ? "hide" : "show"}
              </span>
            </button>

            {open && (
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">
                    Who do you write to? Describe them the way you&rsquo;d say it out loud.
                  </span>
                  <Input
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    placeholder="independent pharmacies with two or three sites"
                    disabled={pending}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">
                    What do you actually want to know from them?
                  </span>
                  <Input
                    value={curiosity}
                    onChange={(e) => setCuriosity(e.target.value)}
                    placeholder="what they wish their supplier did differently"
                    disabled={pending}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">
                    And when you talk to operators in the market, what comes up?
                  </span>
                  <Input
                    value={operatorTopics}
                    onChange={(e) => setOperatorTopics(e.target.value)}
                    placeholder="how consolidation is changing what customers expect"
                    disabled={pending}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Anywhere in particular? (optional)</span>
                  <Input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="the Pacific Northwest"
                    disabled={pending}
                  />
                </label>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !recipients.trim() || !curiosity.trim()}
                    onClick={build}
                  >
                    Build the examples
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your answers supply every specific. A model may tighten the wording
                  afterwards, and if it slips in a place, a number or a name of its own, that
                  version is discarded and you get the plain one.
                </p>
              </div>
            )}
          </div>
        )}

        {notes.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Customer track — writing to someone who <em>uses</em> a provider
          </span>
          <Textarea
            rows={16}
            className="font-mono text-xs"
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
              setDirty(true);
            }}
            disabled={!isAdmin || pending}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Operator track — writing to someone who <em>runs</em> one
          </span>
          <Textarea
            rows={16}
            className="font-mono text-xs"
            value={msp}
            onChange={(e) => {
              setMsp(e.target.value);
              setDirty(true);
            }}
            disabled={!isAdmin || pending}
          />
        </label>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={pending || !dirty}
              onClick={() =>
                run(
                  () => saveWorkedExamples({ goldCustomer: customer, goldMsp: msp }),
                  "Saved. New drafting runs use these.",
                )
              }
            >
              Save examples
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setCustomer(goldCustomer);
                  setMsp(goldMsp);
                  setNotes([]);
                  setDirty(false);
                }}
              >
                Discard changes
              </Button>
            )}
            <p className="w-full text-xs text-muted-foreground">
              Keep the <code>{"{{tokens}}"}</code>, the <code>Email —</code> and{" "}
              <code>LinkedIn —</code> markers and the blank lines between paragraphs: the
              drafting prompt reads all of them. Everything else is yours to rewrite.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
