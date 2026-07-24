import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Runs hub: every batch the pipeline has produced, with its funnel + grading
// metrics and eval-gate status. The control surface for the eval funnel —
// where you see what needs grading and whether a batch may advance.

type BatchStat = {
  id: string;
  module: string;
  label: string;
  gate_status: string;
  created_at: string;
  total: number;
  sampled: number;
  graded: number;
  errors: number;
  pending: number;
  provenance: string | null;
};

const PAGE_SIZE = 30;

function gateVariant(s: string): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const supabase = await createClient();

  const { data, count } = await supabase
    .from("batch_stats")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const rows = (data ?? []) as unknown as BatchStat[];
  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Header summary across all batches (cheap aggregate over the view).
  const { data: allRows } = await supabase
    .from("batch_stats")
    .select("gate_status, pending");
  const summary = (allRows ?? []) as unknown as { gate_status: string; pending: number }[];
  const open = summary.filter((b) => b.gate_status === "open").length;
  const passed = summary.filter((b) => b.gate_status === "passed").length;
  const failed = summary.filter((b) => b.gate_status === "failed").length;
  const needGrading = summary.filter((b) => b.pending > 0).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Runs</h1>
          <p className="text-sm text-muted-foreground">
            Every sourced batch and its eval-gate status. A batch advances only once its graded
            sample clears the error threshold.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/source" />}>
            New sourcing run
          </Button>
          {needGrading > 0 && (
            <Button nativeButton={false} render={<Link href="/review/grade" />}>
              Grade next ({needGrading})
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Need grading" value={needGrading} accent />
        <SummaryCard label="Open" value={open} />
        <SummaryCard label="Passed" value={passed} />
        <SummaryCard label="Failed" value={failed} />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Module</TableHead>
              <TableHead>Gate</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Sample</TableHead>
              <TableHead className="text-right">Graded</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead>Source</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{b.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{b.module}</TableCell>
                  <TableCell>
                    <Badge variant={gateVariant(b.gate_status)}>{b.gate_status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{b.total}</TableCell>
                  <TableCell className="text-right">{b.sampled}</TableCell>
                  <TableCell className="text-right">
                    {b.graded}/{b.sampled}
                  </TableCell>
                  <TableCell className="text-right">{b.errors}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {b.provenance ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {b.pending > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        nativeButton={false}
                        render={<Link href={`/review/grade?batch=${b.id}`} />}
                      >
                        Grade ({b.pending})
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  No runs yet. Start a sourcing run and import the results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
        <span>
          {total} batch{total === 1 ? "" : "es"} · page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          nativeButton={false}
          render={<Link href={`/runs?page=${page - 1}`} />}
        >
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          nativeButton={false}
          render={<Link href={`/runs?page=${page + 1}`} />}
        >
          Next
        </Button>
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
