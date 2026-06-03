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

type Status = "unexplored" | "productive" | "exhausted";

// Actionable first (keep mining / start mining), tapped-out last.
const RANK: Record<Status, number> = { productive: 0, unexplored: 1, exhausted: 2 };

const STATUS_BADGE: Record<Status, { label: string; variant: "default" | "secondary" | "outline" }> = {
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

export default async function MspsPage() {
  const supabase = await createClient();

  const [{ data: mspsData }, { data: customersData }, { data: contactsData }, { data: runsData }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select("id, name, domain, confidence, reviewed")
        .eq("kind", "msp"),
      supabase
        .from("organizations")
        .select("id, current_msp_id, created_at")
        .eq("kind", "customer"),
      supabase.from("contacts").select("organization_id"),
      supabase
        .from("sourcing_runs")
        .select("target_msp_id, new_for_target, created_at")
        .not("target_msp_id", "is", null)
        .order("created_at", { ascending: false }),
    ]);

  const msps = mspsData ?? [];
  const customers = customersData ?? [];
  const runs = runsData ?? [];

  // org id -> its MSP id, to tally contacts per MSP.
  const orgToMsp = new Map<string, string | null>();
  customers.forEach((c) => orgToMsp.set(c.id, c.current_msp_id));
  const contactsByMsp = new Map<string, number>();
  (contactsData ?? []).forEach((ct) => {
    const mspId = orgToMsp.get(ct.organization_id as string);
    if (mspId) contactsByMsp.set(mspId, (contactsByMsp.get(mspId) ?? 0) + 1);
  });

  const rows = msps
    .map((m) => {
      const myCustomers = customers.filter((c) => c.current_msp_id === m.id);
      const lastSourced = myCustomers.reduce<string | null>(
        (acc, c) => (!acc || c.created_at > acc ? c.created_at : acc),
        null,
      );
      const targetedRuns = runs.filter((r) => r.target_msp_id === m.id); // already desc
      const lastYield = targetedRuns[0]?.new_for_target ?? null;
      const status: Status =
        targetedRuns.length === 0
          ? "unexplored"
          : (targetedRuns[0].new_for_target ?? 0) === 0
            ? "exhausted"
            : "productive";
      return {
        id: m.id,
        name: m.name,
        domain: m.domain as string | null,
        flagged: !m.reviewed || m.confidence === "low",
        customers: myCustomers.length,
        contacts: contactsByMsp.get(m.id) ?? 0,
        lastSourced,
        lastYield,
        runs: targetedRuns.length,
        status,
      };
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.customers - a.customers);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">MSPs</h1>
          <p className="text-sm text-muted-foreground">
            Acquisition targets and how much customer coverage we have for each.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/source" />}>
          Source customers →
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Status comes from targeted customer searches: a run that adds new customers keeps
        an MSP <strong>productive</strong>; a targeted run that adds zero marks it{" "}
        <strong>exhausted</strong>. MSPs with no targeted run yet are{" "}
        <strong>unexplored</strong>. Run a targeted search from Import (set &ldquo;Targeting
        one MSP&rdquo;).
      </p>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>MSP</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
              <TableHead>Last sourced</TableHead>
              <TableHead className="text-right">Last run yield</TableHead>
              <TableHead>Status</TableHead>
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
                          {r.flagged && (
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
                    <TableCell>{fmtDate(r.lastSourced)}</TableCell>
                    <TableCell className="text-right">
                      {r.lastYield === null ? "—" : `+${r.lastYield}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No MSPs yet. Import some, or they appear automatically as customers link to
                  them.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
