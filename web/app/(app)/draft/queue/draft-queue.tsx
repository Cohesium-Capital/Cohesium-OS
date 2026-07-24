"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { QueueRow } from "@/lib/drafting/types";
import {
  setApproved,
  setApprovedBulk,
  updateDraft,
  deleteDraft,
  deleteDraftsBulk,
} from "@/lib/drafting/queue-actions";
import { sendApproved } from "@/lib/send/send";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DraftQueue({ initialRows }: { initialRows: QueueRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<QueueRow | null>(null);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleOne(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(initialRows.map((r) => r.id)) : new Set());
  }

  function runBulk(fn: () => Promise<void>, ok: string, withRedraftLink = false) {
    startTransition(async () => {
      try {
        await fn();
        if (withRedraftLink) {
          toast.success(ok, {
            action: { label: "Go to Draft", onClick: () => router.push("/draft") },
          });
        } else {
          toast.success(ok);
        }
        setSelected(new Set());
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  async function doSend() {
    setSending(true);
    try {
      const r = await sendApproved();
      if (r.ok) {
        toast.success(
          `Queued ${r.emailQueued} email (drips out), pushed ${r.linkedinSent} LinkedIn.` +
            (r.skippedResponded ? ` Skipped ${r.skippedResponded} who replied.` : ""),
        );
      } else {
        toast.error(r.error ?? r.errors[0] ?? "Send failed.");
      }
      if (r.errors.length) r.errors.forEach((e) => toast.error(e));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
      setSendOpen(false);
    }
  }

  function run(fn: () => Promise<void>, ok: string) {
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  function openEdit(r: QueueRow) {
    setEditing(r);
    setDraftSubject(r.subject ?? "");
    setDraftBody(r.body);
  }

  function saveEdit() {
    if (!editing) return;
    const patch =
      editing.channel === "email"
        ? { subject: draftSubject.trim() || null, body: draftBody }
        : { body: draftBody };
    run(() => updateDraft(editing.id, patch), "Draft updated.");
    setEditing(null);
  }

  const approvedCount = initialRows.filter((r) => r.approved).length;
  const unapprovedCount = initialRows.length - approvedCount;
  const selectedIds = [...selected];
  const allSelected = initialRows.length > 0 && selected.size === initialRows.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {approvedCount} of {initialRows.length} approved
          {unapprovedCount > 0 && (
            <>
              {" · "}
              <span className="text-foreground">{unapprovedCount} need re-drafting</span>{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => router.push("/draft")}
              >
                (regenerate on Draft →)
              </button>
            </>
          )}
          .
        </p>
        <Button
          disabled={approvedCount === 0 || sending}
          onClick={() => setSendOpen(true)}
        >
          Send approved →
        </Button>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">{selectedIds.length} selected</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              runBulk(
                () => setApprovedBulk(selectedIds, false),
                `${selectedIds.length} sent back to drafting. Regenerate them on the Draft page.`,
                true,
              )
            }
          >
            <Undo2 className="size-4" />
            Send back to drafting
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => runBulk(() => setApprovedBulk(selectedIds, true), "Approved.")}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => runBulk(() => deleteDraftsBulk(selectedIds), "Deleted.")}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all"
                  checked={allSelected}
                  disabled={initialRows.length === 0}
                  onCheckedChange={(v) => toggleAll(!!v)}
                />
              </TableHead>
              <TableHead className="w-10">Send</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Message</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialRows.length ? (
              initialRows.map((r) => (
                <TableRow key={r.id} data-state={selected.has(r.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      aria-label="Select row"
                      checked={selected.has(r.id)}
                      onCheckedChange={(v) => toggleOne(r.id, !!v)}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      checked={r.approved}
                      disabled={pending}
                      onCheckedChange={(v) =>
                        run(
                          () => setApproved(r.id, !!v),
                          v ? "Approved." : "Sent back to drafting.",
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{r.contact_name ?? "—"}</span>
                      <span className="text-xs text-muted-foreground">{r.company}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{r.channel}</Badge>
                      {!r.approved && (
                        <Badge variant="secondary" className="text-[0.65rem]">
                          needs re-draft
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {r.subject && <div className="font-medium">{r.subject}</div>}
                    <div className="line-clamp-2 text-sm text-muted-foreground">
                      {r.body}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(r)}>
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => run(() => deleteDraft(r.id), "Deleted.")}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No drafts yet. Generate some on the Draft page.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={sendOpen} onOpenChange={(o) => !sending && setSendOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send approved messages?</DialogTitle>
            <DialogDescription>
              This queues the {approvedCount} approved message(s): email drips out from
              cohesium.co on a schedule, LinkedIn pushes to HeyReach. Anyone who has
              already replied is skipped. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={doSend} disabled={sending}>
              {sending ? "Sending…" : "Send to campaigns"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit draft</DialogTitle>
            <DialogDescription>
              {editing?.contact_name} · {editing?.company} · {editing?.channel}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {editing?.channel === "email" && (
              <div className="grid gap-2">
                <Label htmlFor="subject">Subject</Label>
                <Input
                  id="subject"
                  value={draftSubject}
                  onChange={(e) => setDraftSubject(e.target.value)}
                />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="body">Body</Label>
              <Textarea
                id="body"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={8}
              />
              {editing?.channel === "linkedin" && (
                <span
                  className={`text-xs ${draftBody.length > 300 ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {draftBody.length}/300
                </span>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
