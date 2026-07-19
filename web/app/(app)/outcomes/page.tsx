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

// Outcomes dashboard: the scoreboard for the learning loop. Reads the
// draft_outcomes view (per prompt version × channel) so reply rates, bounce
// rates, and edit rates can be compared across prompt revisions. Empty until
// drafting/sending produces touches — the funnel fills in as the pipeline runs.

type DraftOutcome = {
  prompt_version_id: string | null;
  module: string | null;
  version: number | null;
  channel: string;
  drafted: number;
  sent: number;
  replied: number;
  bounced: number;
  edited: number;
  reply_rate: number | null;
  first_sent_at: string | null;
  last_sent_at: string | null;
};

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function versionLabel(row: DraftOutcome): string {
  if (!row.prompt_version_id) return "unattributed";
  return `${row.module ?? "?"} v${row.version ?? "?"}`;
}

export default async function OutcomesPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("draft_outcomes")
    .select("*")
    .order("last_sent_at", { ascending: false, nullsFirst: false });

  const rows = (data ?? []) as unknown as DraftOutcome[];

  const totals = rows.reduce(
    (acc, r) => ({
      drafted: acc.drafted + r.drafted,
      sent: acc.sent + r.sent,
      replied: acc.replied + r.replied,
      bounced: acc.bounced + r.bounced,
      edited: acc.edited + r.edited,
    }),
    { drafted: 0, sent: 0, replied: 0, bounced: 0, edited: 0 },
  );
  const overallReplyRate = totals.sent > 0 ? totals.replied / totals.sent : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Outcomes</h1>
          <p className="text-sm text-muted-foreground">
            How drafts perform per prompt version and channel. Edits and reply rates are the
            signals that tell you whether a prompt revision actually improved.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/settings" />}>
          Prompt versions
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Drafted" value={totals.drafted} />
        <SummaryCard label="Sent" value={totals.sent} />
        <SummaryCard label="Replied" value={totals.replied} accent />
        <SummaryCard label="Bounced" value={totals.bounced} />
        <SummaryCard label="Edited before send" value={totals.edited} />
        <SummaryCard label="Reply rate" value={formatRate(overallReplyRate)} />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Prompt version</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Drafted</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Replied</TableHead>
              <TableHead className="text-right">Bounced</TableHead>
              <TableHead className="text-right">Edited</TableHead>
              <TableHead className="text-right">Reply rate</TableHead>
              <TableHead>Last sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((r) => (
                <TableRow key={`${r.prompt_version_id ?? "none"}-${r.channel}`}>
                  <TableCell>
                    {r.prompt_version_id ? (
                      <span className="font-medium">{versionLabel(r)}</span>
                    ) : (
                      <Badge variant="secondary">unattributed</Badge>
                    )}
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">{r.channel}</TableCell>
                  <TableCell className="text-right">{r.drafted}</TableCell>
                  <TableCell className="text-right">{r.sent}</TableCell>
                  <TableCell className="text-right">{r.replied}</TableCell>
                  <TableCell className="text-right">{r.bounced}</TableCell>
                  <TableCell className="text-right">
                    {r.edited}
                    {r.drafted > 0 && r.edited > 0 ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({Math.round((r.edited / r.drafted) * 100)}%)
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatRate(r.reply_rate)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.last_sent_at ? new Date(r.last_sent_at).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  No drafts yet. Rows appear here once messages are drafted in step 5 — each one
                  is attributed to the prompt version that produced it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        &ldquo;Edited&rdquo; counts drafts a human changed before sending — an implicit signal the
        prompt output wasn&rsquo;t good enough as-is. Unattributed rows are legacy touches created
        before provenance tracking.
      </p>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  const highlight = accent && typeof value === "number" && value > 0;
  return (
    <div
      className={`flex min-w-32 flex-col rounded-lg border px-4 py-3 ${
        highlight ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
