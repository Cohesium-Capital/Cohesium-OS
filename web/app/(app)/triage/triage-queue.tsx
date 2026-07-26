"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, X, PenLine, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  setDisposition,
  resolveSuppression,
  searchContacts,
  logInteraction,
  type Disposition,
  type ContactHit,
} from "@/lib/triage/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type TriageInteraction = {
  id: string;
  contact_id: string;
  channel: string;
  occurred_at: string;
  raw_content: string;
  source: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  org_name: string;
  replied_to_subject: string | null;
};

export type PendingSuppression = {
  id: string;
  reason: string;
  source: string | null;
  note: string | null;
  created_at: string;
  contact_name: string;
  org_name: string;
};

// One button per disposition, each with a single-key shortcut. opt_out is
// destructive-styled because it writes an active suppression in the same action.
const DISPOSITIONS: { key: string; value: Disposition; label: string }[] = [
  { key: "p", value: "positive", label: "Positive" },
  { key: "n", value: "neutral", label: "Neutral" },
  { key: "t", value: "not_now", label: "Not now" },
  { key: "o", value: "opt_out", label: "Opt out" },
  { key: "a", value: "ooo_auto", label: "OOO / auto" },
  { key: "w", value: "wrong_person", label: "Wrong person" },
];

type LogChannel = "email" | "linkedin" | "call" | "other";

export function TriageQueue({
  interactions,
  suppressions,
}: {
  interactions: TriageInteraction[];
  suppressions: PendingSuppression[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [index, setIndex] = useState(0);
  // Suppressions resolved this session disappear from the list without waiting
  // for the revalidated payload.
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  // Snapshot the list on mount so triaging the whole queue is stable:
  // setDisposition revalidates this route, which would otherwise re-render us
  // with a shorter interactions prop and shift the reply under our index.
  const [queue, setQueue] = useState(() => interactions);
  // Reconcile fresh props into the snapshot (render-time state adjustment):
  // router.refresh() after logging an interaction — or the done-screen Refresh
  // button — delivers a new interactions prop; append rows we haven't seen so
  // new work surfaces without shifting the operator's position.
  const [lastProp, setLastProp] = useState(interactions);
  if (interactions !== lastProp) {
    setLastProp(interactions);
    setQueue((q) => [...q, ...interactions.filter((i) => !q.some((x) => x.id === i.id))]);
  }
  const current = queue[index];
  const done = index >= queue.length;

  // Log-interaction dialog state.
  const [logOpen, setLogOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Results carry the query they answered, so the displayed list is derived
  // rather than cleared by a setState inside the search effect — and a stale
  // result for a previous query can never flash.
  const [hits, setHits] = useState<{ q: string; rows: ContactHit[] }>({ q: "", rows: [] });
  const [selected, setSelected] = useState<ContactHit | null>(null);
  const [channel, setChannel] = useState<LogChannel>("email");
  const [content, setContent] = useState("");

  const triage = useCallback(
    (disposition: Disposition) => {
      if (!current) return;
      startTransition(async () => {
        try {
          await setDisposition({ interactionId: current.id, disposition });
          setIndex((i) => i + 1);
          if (disposition === "opt_out") {
            toast.success(
              `${current.contact_name ?? "Contact"} suppressed — no channel will send to them again.`,
            );
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Triage failed.");
        }
      });
    },
    [current],
  );

  const resolve = useCallback(
    (suppressionId: string, decision: "confirm" | "revoke") => {
      startTransition(async () => {
        try {
          await resolveSuppression({ suppressionId, decision });
          setResolved((prev) => new Set(prev).add(suppressionId));
          toast.success(decision === "confirm" ? "Suppression confirmed." : "Suppression revoked.");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Action failed.");
        }
      });
    },
    [],
  );

  // Keyboard shortcuts (ignored while typing or while the log dialog is open).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Modified keys are commands (Cmd+A select-all, Cmd+W close-tab), never
      // triage verdicts — one stray chord must not write a disposition.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el?.isContentEditable) return;
      if (pending || logOpen) return;
      const d = DISPOSITIONS.find((x) => x.key === e.key);
      if (d) triage(d.value);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [triage, pending, logOpen]);

  // Debounced contact search for the log dialog.
  useEffect(() => {
    if (!logOpen) return;
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(async () => {
      try {
        setHits({ q, rows: await searchContacts(q) });
      } catch {
        setHits({ q, rows: [] });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, logOpen]);

  // Show results only while they still match what's typed.
  const visibleHits = hits.q === query.trim() && query.trim().length >= 2 ? hits.rows : [];

  function resetLogDialog() {
    setQuery("");
    setHits({ q: "", rows: [] });
    setSelected(null);
    setChannel("email");
    setContent("");
  }

  function saveLog() {
    if (!selected) {
      toast.message("Pick a contact first.");
      return;
    }
    if (!content.trim()) {
      toast.message("Paste the conversation content first.");
      return;
    }
    startTransition(async () => {
      try {
        await logInteraction({ contactId: selected.id, channel, rawContent: content });
        toast.success("Interaction logged — it will appear in the triage queue.");
        setLogOpen(false);
        resetLogDialog();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Log failed.");
      }
    });
  }

  const openSuppressions = suppressions.filter((s) => !resolved.has(s.id));

  return (
    <div className="flex flex-col gap-4">
      {/* Queue header */}
      <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
        <span className="text-muted-foreground">
          {done ? "queue complete" : `${index + 1} of ${queue.length}`}
        </span>
        {openSuppressions.length > 0 && (
          <Badge variant="destructive">
            {openSuppressions.length} suppression{openSuppressions.length === 1 ? "" : "s"} pending
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setLogOpen(true)}
        >
          <Plus className="size-4" /> Log interaction
        </Button>
      </div>

      {/* Pending suppressions: sends to these contacts are blocked until decided. */}
      {openSuppressions.length > 0 && (
        <div
          data-tour="triage-suppressions"
          className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        >
          <p className="text-sm font-medium">Confirm suppressions</p>
          <p className="text-xs text-muted-foreground">
            The auto-matcher flagged these as likely opt-outs. Confirm to make the block
            permanent, revoke if it misread the reply. Sends stay blocked while pending.
          </p>
          <div className="flex flex-col gap-2">
            {openSuppressions.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3 text-sm"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{s.contact_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.org_name} · {s.reason}
                    {s.source ? ` · ${s.source}` : ""}
                  </span>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => resolve(s.id, "confirm")}
                  >
                    <Check className="size-4" /> Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => resolve(s.id, "revoke")}
                  >
                    <X className="size-4" /> Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {done ? (
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm">
            {queue.length === 0
              ? "Nothing to triage — every captured reply has a disposition."
              : `Triaged everything in the queue — ${queue.length} repl${queue.length === 1 ? "y" : "ies"}.`}
          </p>
          <p className="text-sm text-muted-foreground">
            Conversations that automation can&apos;t reach (calls, LinkedIn threads) still
            count — log them so the corpus stays complete.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setLogOpen(true)}>
              <Plus className="size-4" /> Log an interaction
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
              Back to pipeline
            </Button>
            <Button variant="ghost" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        current && (
          <div data-tour="triage-card" className="flex flex-col gap-4 rounded-md border p-5">
            {/* Reply header */}
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-medium">{current.contact_name ?? "—"}</div>
                <div className="text-sm text-muted-foreground">
                  {current.contact_title ? `${current.contact_title} · ` : ""}
                  {current.org_name}
                  {current.contact_email ? ` (${current.contact_email})` : ""}
                </div>
                {current.replied_to_subject && (
                  <div className="text-xs text-muted-foreground">
                    Replying to: {current.replied_to_subject}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{current.channel}</Badge>
                {current.source && <Badge variant="secondary">{current.source}</Badge>}
                <Badge variant="secondary">
                  {new Date(current.occurred_at).toLocaleDateString()}
                </Badge>
              </div>
            </div>

            {/* Verbatim reply — the ground truth behind the verdict. Never trimmed. */}
            <div className="max-h-96 overflow-y-auto rounded-md bg-muted/40 p-4">
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                {current.raw_content}
              </pre>
            </div>

            {/* Decision bar */}
            <div className="flex flex-wrap items-center gap-2">
              {DISPOSITIONS.map((d) => (
                <Button
                  key={d.value}
                  variant={
                    d.value === "positive"
                      ? "default"
                      : d.value === "opt_out"
                        ? "destructive"
                        : "outline"
                  }
                  disabled={pending}
                  onClick={() => triage(d.value)}
                >
                  {d.label} <kbd className="ml-1 text-xs opacity-70">{d.key}</kbd>
                </Button>
              ))}
            </div>
          </div>
        )
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: <kbd>p</kbd> positive · <kbd>n</kbd> neutral · <kbd>t</kbd> not now ·{" "}
        <kbd>o</kbd> opt out · <kbd>a</kbd> OOO/auto · <kbd>w</kbd> wrong person. Opt-out
        writes an active suppression immediately — no channel sends to that contact again.
      </p>

      {/* Log interaction: capture what automation can't reach. */}
      <Dialog
        open={logOpen}
        onOpenChange={(o) => {
          setLogOpen(o);
          if (!o) resetLogDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log an interaction</DialogTitle>
            <DialogDescription>
              Paste a call note, LinkedIn thread, or forwarded email verbatim. It enters
              the triage queue like any captured reply.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid gap-2">
              <Label htmlFor="contact-search">Contact</Label>
              {selected ? (
                <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <PenLine className="size-4 text-muted-foreground" />
                  <span className="font-medium">{selected.full_name ?? "—"}</span>
                  <span className="text-muted-foreground">· {selected.org_name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setSelected(null)}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    id="contact-search"
                    placeholder="Search by name or company…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {visibleHits.length > 0 && (
                    <div className="flex flex-col overflow-hidden rounded-md border">
                      {visibleHits.map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          className="flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                          onClick={() => setSelected(h)}
                        >
                          <span className="font-medium">{h.full_name ?? "—"}</span>
                          <span className="text-muted-foreground">· {h.org_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="grid max-w-xs gap-2">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as LogChannel)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="log-content">Content (verbatim)</Label>
              <Textarea
                id="log-content"
                rows={6}
                placeholder="Paste the conversation exactly as it happened…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveLog} disabled={pending}>
              Log it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
