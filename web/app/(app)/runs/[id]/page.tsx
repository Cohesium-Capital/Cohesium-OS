import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContactKindBadge } from "@/components/contact-kind-badge";
import { RunBadge } from "@/components/run-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type FlowRun,
  furthestStage,
  nextAction,
  runDetailChips,
  runTypeLabel,
  stageCounts,
} from "@/lib/runs/describe";
import { formatDateTime, relativeTime } from "@/lib/format/date";

// One run, and the records it produced. The timeline answers "where does this
// run sit"; this page answers "which rows are we actually talking about", which
// is the question every stage action on the timeline implicitly makes.

type ContactRecord = {
  id: string;
  full_name: string | null;
  title: string | null;
  reviewed: boolean;
  enrichment_status: string;
  email: string | null;
  deleted_at: string | null;
  organizations: { name: string; domain: string | null; kind: string | null } | null;
};

// Furthest point each record reached, so the table reads as progress rather
// than a pile of booleans.
function recordStage(
  c: ContactRecord,
  hooked: Set<string>,
  drafted: Set<string>,
  sent: Set<string>,
): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (c.deleted_at) return { label: "Discarded", variant: "destructive" };
  if (sent.has(c.id)) return { label: "Sent", variant: "default" };
  if (drafted.has(c.id)) return { label: "Drafted", variant: "default" };
  if (hooked.has(c.id)) return { label: "Personalized", variant: "secondary" };
  if (c.enrichment_status === "enriched") return { label: "Enriched", variant: "secondary" };
  if (c.reviewed) return { label: "Reviewed", variant: "outline" };
  return { label: "Needs review", variant: "outline" };
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: runData } = await supabase
    .from("flow_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!runData) notFound();
  const run = runData as unknown as FlowRun;

  // The run's records, via the same attribution the funnel counts use. A
  // pre-run-tracking batch entry has no run to join through, so its records
  // come from the batch directly — otherwise the largest historical entries
  // would be the only ones you cannot open.
  const contactIds =
    run.entry_kind === "batch" && run.batch_id
      ? ((
          await supabase.from("contacts").select("id").eq("batch_id", run.batch_id)
        ).data ?? []).map((r) => r.id as string)
      : (
          (await supabase.from("contact_runs").select("contact_id").eq("run_id", id)).data ??
          []
        ).map((r) => r.contact_id as string);

  const [{ data: contactData }, { data: hookRows }, { data: touchRows }] = await Promise.all([
    contactIds.length
      ? supabase
          .from("contacts")
          .select(
            "id, full_name, title, reviewed, enrichment_status, email, deleted_at, organizations(name, domain, kind)",
          )
          .in("id", contactIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    contactIds.length
      ? supabase
          .from("hooks")
          .select("contact_id")
          .in("contact_id", contactIds)
          .neq("status", "rejected")
      : Promise.resolve({ data: [] }),
    contactIds.length
      ? supabase
          .from("touches")
          .select("contact_id, status, sent_at, deleted_at")
          .in("contact_id", contactIds)
          .eq("direction", "outbound")
      : Promise.resolve({ data: [] }),
  ]);

  const records = (contactData ?? []) as unknown as ContactRecord[];
  const hooked = new Set((hookRows ?? []).map((h) => h.contact_id as string));
  const drafted = new Set(
    (touchRows ?? []).filter((t) => !t.deleted_at).map((t) => t.contact_id as string),
  );
  const sent = new Set(
    (touchRows ?? [])
      .filter(
        (t) =>
          t.sent_at !== null ||
          ["sent", "delivered", "replied", "bounced"].includes(t.status as string),
      )
      .map((t) => t.contact_id as string),
  );

  const action = nextAction(run);
  const chips = runDetailChips(run);
  const furthest = furthestStage(run);
  const stages = stageCounts(run);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <RunBadge code={run.run_code} />
            <h1 className="text-2xl font-semibold">{runTypeLabel(run)}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Ran {formatDateTime(run.created_at)} · {relativeTime(run.created_at)}
            {run.batch_label ? ` · batch ${run.batch_label}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/runs" />}>
            All runs
          </Button>
          {action && (
            <Button size="sm" nativeButton={false} render={<Link href={action.href} />}>
              {action.label}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {run.gate_status && (
          <Badge variant={run.gate_status === "failed" ? "destructive" : "secondary"}>
            gate {run.gate_status}
          </Badge>
        )}
        {chips.map((c) => (
          <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            {c}
          </span>
        ))}
        {run.sampled > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            graded {run.graded}/{run.sampled}
          </span>
        )}
        {furthest && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            furthest stage: {furthest.label}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {stages.map((s) => (
          <div key={s.key} className="flex min-w-24 flex-col rounded-lg border px-4 py-3">
            <span className="text-2xl font-semibold tabular-nums">{s.count}</span>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </div>
        ))}
        {run.discarded > 0 && (
          <div className="flex min-w-24 flex-col rounded-lg border px-4 py-3">
            <span className="text-2xl font-semibold tabular-nums">{run.discarded}</span>
            <span className="text-xs text-muted-foreground">Discarded</span>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-medium">
          Records{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({records.length} contact{records.length === 1 ? "" : "s"} from this run)
          </span>
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.map((c) => {
                  const stage = recordStage(c, hooked, drafted, sent);
                  return (
                    <TableRow key={c.id} className={c.deleted_at ? "opacity-60" : undefined}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{c.full_name ?? "—"}</span>
                          {c.title && (
                            <span className="text-xs text-muted-foreground">{c.title}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          {c.organizations?.name ?? "—"}
                          <ContactKindBadge kind={c.organizations?.kind ?? null} />
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.email ?? <span className="text-xs">not enriched</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stage.variant}>{stage.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    This run has no records attributed to it.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
