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
// draft_outcomes view (per prompt version × channel × track) so reply rates,
// positive-reply rates, and edit rates can be compared across prompt revisions
// and audiences. "Replied" is raw volume (opt-outs and autoresponders count);
// "positive" is the human-triaged disposition — the honest signal. Empty until
// drafting/sending produces touches — the funnel fills in as the pipeline runs.
// Also reads hook_outcomes (per hook kind × track) — the instrument for the
// personalization stage's rent check against the no-hook control arm.

// One row per hook kind × track from the hook_outcomes view. 'no_hook' is the
// control arm: touches drafted with no hook attached at all. kind='none' is the
// explicit honest-fallback artifact — distinct from having skipped the stage.
type HookOutcome = {
  hook_kind: string;
  track: string | null;
  drafted: number;
  sent: number;
  replied: number;
  positive_replied: number;
  positive_reply_rate: number | null;
};

type DraftOutcome = {
  prompt_version_id: string | null;
  module: string | null;
  version: number | null;
  channel: string;
  track: string | null;
  drafted: number;
  sent: number;
  replied: number;
  positive_replied: number;
  opted_out: number;
  bounced: number;
  failed: number;
  edited: number;
  reply_rate: number | null;
  positive_reply_rate: number | null;
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

function trackLabel(track: string | null): string {
  if (track === "msp") return "MSP";
  if (track === "customer") return "Customer";
  return "—";
}

function hookKindLabel(kind: string): string {
  if (kind === "no_hook") return "no hook attached";
  if (kind === "none") return "none (fallback angle)";
  return kind.replace(/_/g, " ");
}

export default async function OutcomesPage() {
  const supabase = await createClient();

  const [{ data }, { data: hookData }] = await Promise.all([
    supabase
      .from("draft_outcomes")
      .select("*")
      .order("last_sent_at", { ascending: false, nullsFirst: false }),
    supabase
      .from("hook_outcomes")
      .select("*")
      .order("track", { ascending: true })
      .order("hook_kind", { ascending: true }),
  ]);

  const rows = (data ?? []) as unknown as DraftOutcome[];
  const hookRows = (hookData ?? []) as unknown as HookOutcome[];

  const totals = rows.reduce(
    (acc, r) => ({
      drafted: acc.drafted + r.drafted,
      sent: acc.sent + r.sent,
      replied: acc.replied + r.replied,
      positive: acc.positive + r.positive_replied,
      bounced: acc.bounced + r.bounced,
      edited: acc.edited + r.edited,
    }),
    { drafted: 0, sent: 0, replied: 0, positive: 0, bounced: 0, edited: 0 },
  );
  const overallReplyRate = totals.sent > 0 ? totals.replied / totals.sent : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Outcomes</h1>
          <p className="text-sm text-muted-foreground">
            How drafts perform per prompt version, channel, and track. Edits and positive-reply
            rates are the signals that tell you whether a prompt revision actually improved.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/settings" />}>
          Prompt versions
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Drafted" value={totals.drafted} />
        <SummaryCard label="Sent" value={totals.sent} />
        <SummaryCard label="Replied" value={totals.replied} />
        <SummaryCard label="Positive replies" value={totals.positive} accent />
        <SummaryCard label="Bounced" value={totals.bounced} />
        <SummaryCard label="Edited before send" value={totals.edited} />
        <SummaryCard label="Reply rate" value={formatRate(overallReplyRate)} />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Prompt version</TableHead>
              <TableHead>Track</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Drafted</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Replied</TableHead>
              <TableHead className="text-right">Positive</TableHead>
              <TableHead className="text-right">Opted out</TableHead>
              <TableHead className="text-right">Bounced</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Edited</TableHead>
              <TableHead className="text-right">Reply rate</TableHead>
              <TableHead className="text-right">Positive rate</TableHead>
              <TableHead>Last sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((r) => (
                <TableRow
                  key={`${r.prompt_version_id ?? "none"}-${r.channel}-${r.track ?? "none"}`}
                >
                  <TableCell>
                    {r.prompt_version_id ? (
                      <span className="font-medium">{versionLabel(r)}</span>
                    ) : (
                      <Badge variant="secondary">unattributed</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {trackLabel(r.track)}
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">{r.channel}</TableCell>
                  <TableCell className="text-right">{r.drafted}</TableCell>
                  <TableCell className="text-right">{r.sent}</TableCell>
                  <TableCell className="text-right">{r.replied}</TableCell>
                  <TableCell className="text-right">{r.positive_replied}</TableCell>
                  <TableCell className="text-right">{r.opted_out}</TableCell>
                  <TableCell className="text-right">{r.bounced}</TableCell>
                  <TableCell className="text-right">{r.failed}</TableCell>
                  <TableCell className="text-right">
                    {r.edited}
                    {r.drafted > 0 && r.edited > 0 ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({Math.round((r.edited / r.drafted) * 100)}%)
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">{formatRate(r.reply_rate)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatRate(r.positive_reply_rate)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.last_sent_at ? new Date(r.last_sent_at).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={14} className="h-24 text-center text-muted-foreground">
                  No drafts yet. Rows appear here once messages are drafted in step 5 — each one
                  is attributed to the prompt version that produced it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        &ldquo;Positive rate&rdquo; is replies a human triaged as positive ÷ sent — raw
        &ldquo;Replied&rdquo; counts everything that came back, opt-outs included, so it
        flatters. &ldquo;Edited&rdquo; counts drafts a human changed before sending — an
        implicit signal the prompt output wasn&rsquo;t good enough as-is. Unattributed rows are
        legacy touches created before provenance tracking.
      </p>

      {/* Hooks vs no hook: the personalization stage's rent check, per hook
          kind × track. The 'no hook attached' row is the control arm. */}
      <div className="flex flex-col gap-2">
        <div>
          <h2 className="text-lg font-semibold">Hooks vs no hook</h2>
          <p className="text-sm text-muted-foreground">
            Do verified hooks earn more positive replies than drafts sent without one?
          </p>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hook kind</TableHead>
                <TableHead>Track</TableHead>
                <TableHead className="text-right">Drafted</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead className="text-right">Positive</TableHead>
                <TableHead className="text-right">Positive rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hookRows.length ? (
                hookRows.map((r) => (
                  <TableRow key={`${r.hook_kind}-${r.track ?? "none"}`}>
                    <TableCell className="font-medium">{hookKindLabel(r.hook_kind)}</TableCell>
                    <TableCell className="text-muted-foreground">{trackLabel(r.track)}</TableCell>
                    <TableCell className="text-right">{r.drafted}</TableCell>
                    <TableCell className="text-right">{r.sent}</TableCell>
                    <TableCell className="text-right">{r.replied}</TableCell>
                    <TableCell className="text-right">{r.positive_replied}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatRate(r.positive_reply_rate === null ? null : Number(r.positive_reply_rate))}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No outbound touches yet. Rows appear once drafts carry a hook (or explicitly
                    don&rsquo;t) and start going out.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          The rent check: if verified hooks don&rsquo;t beat the no-hook arm on positive replies
          within a quarter, the Personalize stage folds back into drafting. &ldquo;No hook
          attached&rdquo; is a touch drafted without any hook; &ldquo;none (fallback
          angle)&rdquo; is the honest researched outcome that nothing hook-worthy exists — both
          are controls, not failures.
        </p>
      </div>
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
