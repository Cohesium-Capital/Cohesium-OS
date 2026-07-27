"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  approveAccessRequest,
  denyAccessRequest,
  type AccessRequest,
} from "@/lib/access/actions";
import { formatDate } from "@/lib/format/date";

// Pending access requests, for whoever runs this deployment.
//
// Approving is a provisioning action, not a permission grant: it creates a NEW
// workspace with the requester as its admin. They get their own tenant and no
// access whatsoever to yours, which is worth being explicit about on the button
// that does it.

export function AccessRequestsPanel({ requests }: { requests: AccessRequest[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [names, setNames] = useState<Record<string, string>>({});

  if (!requests.length) return null;

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="size-4" />
          Access requests
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground tabular-nums">
            {requests.length}
          </span>
        </CardTitle>
        <CardDescription>
          Approving creates a new, empty workspace with this person as its admin — their own
          tenant. They get no access to yours, and you get none to theirs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {requests.map((r) => (
          <div key={r.id} className="flex flex-col gap-2 rounded-md border bg-background p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{r.fullName ?? r.email}</span>
              <span className="text-muted-foreground">{r.email}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                asked {formatDate(r.createdAt)}
              </span>
            </div>
            {r.note && <p className="text-sm text-muted-foreground">{r.note}</p>}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Workspace name</span>
                <Input
                  className="w-64"
                  value={names[r.id] ?? r.firmName ?? ""}
                  placeholder={r.firmName ?? "Their firm"}
                  onChange={(e) => setNames((n) => ({ ...n, [r.id]: e.target.value }))}
                  disabled={pending}
                />
              </label>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () => approveAccessRequest(r.id, names[r.id] ?? r.firmName ?? undefined),
                    "Approved — their workspace is ready.",
                  )
                }
              >
                Approve &amp; create workspace
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() => denyAccessRequest(r.id, ""), "Declined.")
                }
              >
                Decline
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
