import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MspControls } from "./msp-controls";
import { formatDate, relativeTime } from "@/lib/format/date";

type Status = "unexplored" | "productive" | "exhausted";

type MspStatRow = {
  id: string;
  name: string;
  domain: string | null;
  confidence: string | null;
  reviewed: boolean;
  customers: number;
  contacts: number;
  last_sourced: string | null;
  targeted_runs: number;
  last_yield: number | null;
  status: Status;
  added_at: string;
};

const PAGE_SIZE = 50;

const STATUS_BADGE: Record<
  Status,
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  productive: { label: "Productive", variant: "default" },
  unexplored: { label: "Unexplored", variant: "secondary" },
  exhausted: { label: "Exhausted — move on", variant: "outline" },
};

const fmtDate = formatDate;

export default async function MspsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  // Scope reads to the workspace on screen; RLS already bounds them to the
  // workspaces this user belongs to at all.
  const workspaceId = await currentWorkspaceId();
  let query = supabase
    .from("msp_stats")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId);
  if (q) query = query.ilike("name", `%${q}%`);
  const { data, count } = await query
    .order("status_rank", { ascending: true })
    .order("customers", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const rows = (data as MspStatRow[]) ?? [];
  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Target Companies</h1>
        <p className="text-sm text-muted-foreground">
          Acquisition targets and how much customer coverage we have for each.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Status comes from targeted customer searches: a run that adds new customers keeps
        a target company <strong>productive</strong>; a targeted run that adds zero marks it{" "}
        <strong>exhausted</strong>. Target companies with no targeted run yet are{" "}
        <strong>unexplored</strong>. Use the per-row shortcut to run a targeted search.
      </p>

      <p className="text-sm text-muted-foreground">
        An <span className="text-amber-600">unconfirmed</span> tag next to a name means the
        company record itself hasn&rsquo;t been vetted — either nobody has reviewed it, or it
        was imported with low confidence. Most are stubs created automatically because a
        customer record named that company, so the name may be a guess. Check the details before
        treating one as a real acquisition target.
      </p>

      <MspControls q={q} page={page} pageCount={pageCount} total={total} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Target Company</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Last sourced</TableHead>
              <TableHead className="text-right">Last run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((r) => {
                const badge = STATUS_BADGE[r.status];
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>
                          {r.name}
                          {(!r.reviewed || r.confidence === "low") && (
                            <span
                              className="ml-2 text-xs text-amber-600"
                              title={
                                r.reviewed
                                  ? "Low confidence — the company details came from weak evidence. Confirm before relying on it."
                                  : "Nobody has confirmed this target company yet. Many are auto-created from a customer record that named them."
                              }
                            >
                              unconfirmed
                            </span>
                          )}
                        </span>
                        {r.domain && (
                          <span className="text-xs text-muted-foreground">{r.domain}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{r.customers}</TableCell>
                    <TableCell className="text-right">{r.contacts}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{fmtDate(r.added_at)}</span>
                        <span className="text-xs text-muted-foreground">
                          {relativeTime(r.added_at)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{fmtDate(r.last_sourced)}</TableCell>
                    <TableCell className="text-right">
                      {r.last_yield === null ? "—" : `+${r.last_yield}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        nativeButton={false}
                        render={<Link href={`/source?msp=${r.id}`} />}
                      >
                        Source customers
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  {q
                    ? "No target companies match that search."
                    : "No target companies yet. Import some, or they appear as customers link to them."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
