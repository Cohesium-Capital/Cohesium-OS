"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createApiToken, revokeApiToken } from "@/lib/auth/token-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type ApiTokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

function status(t: ApiTokenRow): { label: string; tone: "ok" | "muted" | "bad" } {
  if (t.revoked_at) return { label: "revoked", tone: "bad" };
  if (t.expires_at && new Date(t.expires_at) < new Date()) return { label: "expired", tone: "bad" };
  if (!t.last_used_at) return { label: "never used", tone: "muted" };
  return { label: `used ${fmt(t.last_used_at)}`, tone: "ok" };
}

// Runner API tokens. A token authenticates a Claude Code session as its owner —
// the API mints a short-lived user JWT from it, so the session sees exactly what
// that person's browser session would and nothing more.
export function ApiTokens({ tokens }: { tokens: ApiTokenRow[] }) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  // Shown once, then unrecoverable: only the hash is stored.
  const [fresh, setFresh] = useState<{ name: string; raw: string } | null>(null);

  function create() {
    if (!name.trim()) {
      toast.error("Name the token first.");
      return;
    }
    startTransition(async () => {
      try {
        const t = await createApiToken({ name });
        setFresh({ name: t.name, raw: t.raw });
        setName("");
        toast.success("Token created — copy it now, it won't be shown again.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not create token.");
      }
    });
  }

  function revoke(id: string, tokenName: string) {
    startTransition(async () => {
      try {
        await revokeApiToken(id);
        toast.success(`Revoked "${tokenName}".`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not revoke token.");
      }
    });
  }

  const live = tokens.filter((t) => !t.revoked_at);

  return (
    <Card>
      <CardHeader>
        <CardTitle>API tokens</CardTitle>
        <CardDescription>
          For the Claude Code sourcing runner. A token acts as <strong>you</strong> — requests run
          under your row-level permissions, never with elevated access — and only its hash is
          stored, so it can&rsquo;t be recovered after creation. Revoke anything you no longer
          recognise.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {fresh && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-sm font-medium">
              New token &ldquo;{fresh.name}&rdquo; — copy it now
            </p>
            <p className="mt-1 break-all rounded bg-background p-2 font-mono text-xs">
              {fresh.raw}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(fresh.raw);
                  toast.success("Copied.");
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
                Done
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Put it in the runner&rsquo;s environment as{" "}
              <code className="font-mono">COHESIUM_API_TOKEN</code>. This is the only time it is
              shown.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="token-name">New token name</Label>
            <Input
              id="token-name"
              placeholder="e.g. laptop — sourcing runner"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-72"
            />
          </div>
          <Button size="sm" onClick={create} disabled={pending}>
            Create token
          </Button>
        </div>

        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active tokens. The runner API rejects every request until you create one.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {tokens.map((t) => {
              const s = status(t);
              return (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{t.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{t.scopes.join(", ")}</Badge>
                    <span
                      className={
                        s.tone === "bad"
                          ? "text-destructive"
                          : s.tone === "ok"
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {s.label}
                    </span>
                    <span className="text-muted-foreground">created {fmt(t.created_at)}</span>
                    {!t.revoked_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => revoke(t.id, t.name)}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
