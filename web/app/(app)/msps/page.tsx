import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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
  let query = supabase.from("msp_stats").select("*", { count: "exact" });
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
        <h1 className="text-2xl font-semibold">MSPs</h1>
        <p className="text-sm text-muted-foreground">
          Acquisition targets and how much customer coverage we have for each.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Status comes from targeted customer searches: a run that adds new customers keeps
        an MSP <strong>productive</strong>; a targeted run that adds zero marks it{" "}
        <strong>exhausted</strong>. MSPs with no targeted run yet are{" "}
        <strong>unexplored</strong>. Use the per-row shortcut to run a targeted search.
      </p>

      <MspControls q={q} page={page} pageCount={pageCount} total={total} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>MSP</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
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
                            <span className="ml-2 text-xs text-amber-600">flagged</span>
                          )}
                        </span>
                        {r.domain && (
                          <span className="text-xs text-muted-foreground">{r.domain}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{r.customers}</TableCell>
                    <TableCell className="text-right">{r.contacts}</TableCell>
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
                <TableCell colSpan={7} className="h-24 text-center">
                  {q
                    ? "No MSPs match that search."
                    : "No MSPs yet. Import some, or they appear as customers link to them."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
