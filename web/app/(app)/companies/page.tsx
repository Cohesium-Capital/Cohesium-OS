import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
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
import { CompanyControls } from "./company-controls";
import type { CompanyKindFilter, CompanySort } from "./types";
import { daysAgoIso, formatDate, relativeTime } from "@/lib/format/date";

// Every company the pipeline has produced — customers and the MSPs / acquisition
// targets — with the date it was added. Sourcing surfaces answer "what should we
// research next"; this one answers "what do we actually hold, and since when".

type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  kind: string | null;
  confidence: string | null;
  reviewed: boolean;
  hq_city: string | null;
  hq_state: string | null;
  current_msp_name: string | null;
  contacts: number;
  contacts_reviewed: number;
  contacts_enriched: number;
  added_at: string;
  first_run_id: string | null;
  first_run_code: string | null;
  first_run_at: string | null;
};

const PAGE_SIZE = 50;

const SORT: Record<CompanySort, { column: string; ascending: boolean }> = {
  newest: { column: "added_at", ascending: false },
  oldest: { column: "added_at", ascending: true },
  name: { column: "name", ascending: true },
  contacts: { column: "contacts", ascending: false },
};

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string; sort?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const kind: CompanyKindFilter =
    sp.kind === "customer" || sp.kind === "msp" ? sp.kind : "all";
  const sort: CompanySort =
    sp.sort === "oldest" || sp.sort === "name" || sp.sort === "contacts"
      ? sp.sort
      : "newest";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  // Scope reads to the workspace on screen; RLS already bounds them to the
  // workspaces this user belongs to at all.
  const workspaceId = await currentWorkspaceId();
  let query = supabase
    .from("company_list")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId);
  if (kind !== "all") query = query.eq("kind", kind);
  if (q) query = query.ilike("name", `%${q}%`);
  const order = SORT[sort];
  const { data, count } = await query
    .order(order.column, { ascending: order.ascending })
    .range(from, from + PAGE_SIZE - 1);

  const rows = (data ?? []) as unknown as CompanyRow[];
  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Headline counts are unfiltered — the filters scope the table, not the totals.
  const [customers, msps, recent] = await Promise.all([
    supabase
      .from("company_list")
      .select("id", { count: "exact", head: true })
      .eq("kind", "customer"),
    supabase
      .from("company_list")
      .select("id", { count: "exact", head: true })
      .eq("kind", "msp"),
    supabase
      .from("company_list")
      .select("id", { count: "exact", head: true })
      .gte("added_at", daysAgoIso(7)),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Companies</h1>
        <p className="text-sm text-muted-foreground">
          Every customer and MSP the pipeline has added, newest first. &ldquo;Added&rdquo; is
          when the company first entered the database — re-sourcing an existing company merges
          into the original row and does not reset it.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Customers" value={customers.count ?? 0} />
        <SummaryCard label="MSPs / targets" value={msps.count ?? 0} />
        <SummaryCard label="Added in last 7 days" value={recent.count ?? 0} accent />
      </div>

      <CompanyControls q={q} kind={kind} sort={sort} page={page} pageCount={pageCount} total={total} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Estimated MSP</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
              <TableHead>First run</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="flex items-center gap-1.5">
                        {r.name}
                        {(!r.reviewed || r.confidence === "low") && (
                          <span
                            className="text-xs text-amber-600"
                            title={
                              r.reviewed
                                ? "Low confidence — the company details came from weak evidence."
                                : "Nobody has confirmed this company record yet."
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
                  <TableCell>
                    <ContactKindBadge kind={r.kind} />
                  </TableCell>
                  <TableCell>
                    {r.current_msp_name ? (
                      <Link
                        href={`/msps?q=${encodeURIComponent(r.current_msp_name)}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {r.current_msp_name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {[r.hq_city, r.hq_state].filter(Boolean).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.contacts > 0 ? (
                      <Link
                        href={`/review?q=${encodeURIComponent(r.name)}`}
                        className="underline-offset-2 hover:underline"
                        title={`${r.contacts_reviewed} reviewed · ${r.contacts_enriched} enriched`}
                      >
                        {r.contacts}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <RunBadge code={r.first_run_code} runId={r.first_run_id} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{formatDate(r.added_at)}</span>
                      <span className="text-xs text-muted-foreground">
                        {relativeTime(r.added_at)}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {q || kind !== "all"
                    ? "No companies match."
                    : "No companies yet. Start a sourcing run to add some."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`flex min-w-32 flex-col rounded-lg border px-4 py-3 ${
        accent && value > 0 ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
