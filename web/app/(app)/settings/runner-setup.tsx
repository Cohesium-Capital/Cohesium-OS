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
// The point is that onboarding a collaborator requires no access to THIS
// repository. Claude Code asks for one when creating an environment, so the
// skill is published in a public repo of its own; the download here covers the
// terminal, where there is no picker to satisfy. A token is also a much narrower
// grant than an app login — scope 'sourcing', three endpoints, none of the UI.

export function RunnerSetup({
  skill,
  repoUrl,
  envTemplate,
  hasLiveToken,
}: {
  skill: { filename: string; installPath: string; content: string };
  /** Public repo carrying the skill — the route that satisfies Claude Code's
   *  environment picker without granting access to this codebase. */
  repoUrl: string;
  /** Built server-side from the request host, so it is already correct for
   *  prod, preview or localhost without anyone editing it. */
  envTemplate: string;
  hasLiveToken: boolean;
}) {

  // "Cohesium-Capital/cohesium-runner" — what you actually type into the picker.
  const repoSlug = repoUrl.replace(/^https?:\/\/github\.com\//, "");

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
    // Anchor target for "Set up the runner →" on Source. scroll-mt keeps the
    // heading clear of the sticky app header when jumped to.
    <Card id="runner-setup" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Runner setup (Claude Code)</CardTitle>
        <CardDescription>
          The copy-paste prompt can only carry ~400 already-sourced companies before the model
          stops reliably honouring the list. The runner has no such limit — it asks the API which
          candidates are new, checked against every company on file, so it never re-researches
          what you already have. Set it up from here;{" "}
          <strong>no access to this codebase required</strong>.
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
            <div className="font-medium">2. Give Claude Code the skill</div>
            <p className="text-muted-foreground">
              Claude Code asks for a repository when you create an environment, so point it at
              the public runner repo. The skill comes with it — nothing to install, and no access
              to this codebase needed. It holds no credentials and no application code.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<a href={repoUrl} target="_blank" rel="noreferrer" />}
              >
                Open the runner repo ↗
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copy(repoSlug, "Repo name")}>
                Copy <code className="ml-1 font-mono text-xs">{repoSlug}</code>
              </Button>
            </div>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">Using the terminal instead?</summary>
              <p className="mt-2">
                There is no repository picker in the CLI, so the skill can live anywhere. Save it
                at{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {skill.installPath}
                </code>{" "}
                — the personal skills location — and it works from any folder.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
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
            </details>
          </li>

          <li className="flex flex-col gap-2">
            <div className="font-medium">3. Add the credentials</div>
            <p className="text-muted-foreground">
              Set these in the environment&rsquo;s variables, or save them as a{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code> in the
              folder Claude Code opens. An{" "}
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
              Open it in Claude Code and say it plainly — e.g.{" "}
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
