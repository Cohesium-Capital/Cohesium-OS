"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Everything a person needs to run sourcing through Claude Code, handed over
// from inside the app.
//
// The point is that onboarding a collaborator requires no repository access:
// the skill file and the .env are downloadable here, so "give someone the
// runner" never means "add them to GitHub". A token is also a much narrower
// grant than an app login — scope 'sourcing', three endpoints, none of the UI.

export function RunnerSetup({
  skill,
  envTemplate,
  hasLiveToken,
}: {
  skill: { filename: string; installPath: string; content: string };
  /** Built server-side from the request host, so it is already correct for
   *  prod, preview or localhost without anyone editing it. */
  envTemplate: string;
  hasLiveToken: boolean;
}) {

  function download(filename: string, body: string, type: string) {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${filename} downloaded.`);
  }

  function copy(body: string, what: string) {
    navigator.clipboard.writeText(body);
    toast.success(`${what} copied.`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runner setup (Claude Code)</CardTitle>
        <CardDescription>
          The copy-paste prompt can only carry ~400 already-sourced companies before the model
          stops reliably honouring the list. The runner has no such limit — it asks the API which
          candidates are new, checked against every company on file, so it never re-researches
          what you already have. Everything needed is on this page;{" "}
          <strong>no repository access required</strong>.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 text-sm">
        <ol className="flex flex-col gap-5">
          <li className="flex flex-col gap-2">
            <div className="font-medium">1. Create an API token</div>
            <p className="text-muted-foreground">
              In <span className="font-medium text-foreground">API tokens</span> below. Copy it
              immediately — only its hash is stored, so it can&rsquo;t be shown again. Give each
              person their own, named for them, rather than sharing one: revoking is then per
              person, and every run records which token produced it.
            </p>
            {!hasLiveToken && (
              <p className="text-amber-600">
                No active token yet — the runner API rejects every request until you create one.
              </p>
            )}
          </li>

          <li className="flex flex-col gap-2">
            <div className="font-medium">2. Install the skill file</div>
            <p className="text-muted-foreground">
              Download it and save it at{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {skill.installPath}
              </code>
              . That is the personal skills location, so it works from any folder — the person
              never needs this repository checked out.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(skill.filename, skill.content, "text/markdown")}
              >
                Download {skill.filename}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(skill.content, skill.filename)}
              >
                Copy contents
              </Button>
            </div>
          </li>

          <li className="flex flex-col gap-2">
            <div className="font-medium">3. Add the credentials</div>
            <p className="text-muted-foreground">
              Save this as <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code>{" "}
              in whatever folder they open with Claude Code, and paste the token in. An{" "}
              <code className="font-mono text-xs">export</code> in one terminal won&rsquo;t be
              visible to a Claude Code session started from the desktop app, which is why the
              skill reads a file instead.
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {envTemplate}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => download(".env", envTemplate, "text/plain")}>
                Download .env
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copy(envTemplate, ".env")}>
                Copy
              </Button>
            </div>
          </li>

          <li className="flex flex-col gap-2">
            <div className="font-medium">4. Ask for what you want</div>
            <p className="text-muted-foreground">
              Open that folder in Claude Code and say it plainly — e.g.{" "}
              <em>
                &ldquo;Source 25 customers in the Richmond VA metro, 20–100 employee professional
                services firms.&rdquo;
              </em>{" "}
              Results land in Review &amp; Enrich as a normal batch and still have to pass Grade
              before they can be enriched or drafted. The runner is not a trusted shortcut.
            </p>
          </li>
        </ol>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="font-medium">What a token grants</p>
          <p className="mt-1 text-muted-foreground">
            Only three sourcing endpoints — start a run, check candidates, ingest results — acting
            with its owner&rsquo;s row-level permissions. It cannot reach the rest of the app: no
            Clay pushes, no sending, no deletions. That makes it a{" "}
            <strong>narrower</strong> grant than an app login, which is why it suits a
            collaborator who shouldn&rsquo;t have one. Send it over something ephemeral rather
            than email or chat — it is a bearer credential with no second factor.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
