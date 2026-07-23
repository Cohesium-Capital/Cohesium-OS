import Link from "next/link";
import {
  Radar,
  ClipboardCheck,
  GraduationCap,
  PenLine,
  Send,
  Inbox,
  Activity,
  Building2,
  ArrowRight,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getNextAction, countDraftable } from "@/lib/journey";
import { countEligibleContacts } from "@/lib/enrichment/pending";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Home = the work queue. Steps render in workflow order with a live count of
// what's waiting at each stage plus that stage's gate reading, so the next
// thing to do is obvious and the pipeline's health reads at a glance. Gate
// chips are honest: a stage with no data yet shows a dash, never a green —
// a metric chip is a promise the loop behind it is live. The health strip
// surfaces the failure modes that would otherwise hide until they'd
// compounded: failed sends, bounces, pending suppressions, untriaged
// replies, cap usage, failed gates.

type Step = {
  href: string;
  step: number;
  label: string;
  icon: LucideIcon;
  blurb: string;
  count: number | null;
  countNoun: string;
  // The stage's gate/metric reading. tone 'ok' only when the loop is live and
  // healthy; 'warn' when it needs attention; 'muted' for honest no-data.
  chip: { text: string; tone: "ok" | "warn" | "muted" };
};

type HealthChip = {
  href: string;
  label: string;
  value: string;
  // Tints the chip when something needs attention; zero stays calm.
  alert: boolean;
};

export default async function HomePage() {
  const supabase = await createClient();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const emailCap = Number(process.env.EMAIL_DAILY_CAP ?? 20) || 20;

  const [
    toReview,
    awaitingGrade,
    pendingEnrich,
    inQueue,
    untriaged,
    pendingSuppressions,
    failedSends,
    bounced7d,
    sent24h,
    failedBatches,
    next,
  ] = await Promise.all([
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("reviewed", false)
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("sampled", true)
      .eq("review_status", "pending_review")
      .not("batch_id", "is", null)
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "pending")
      .is("deleted_at", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("status", "planned")
      .eq("direction", "outbound")
      .is("deleted_at", null),
    supabase
      .from("interactions")
      .select("id, contacts!inner(id)", { count: "exact", head: true })
      .is("disposition", null)
      .is("contacts.deleted_at", null),
    supabase
      .from("suppressions")
      .select("id, contacts!inner(id)", { count: "exact", head: true })
      .eq("status", "pending")
      .is("contacts.deleted_at", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .is("deleted_at", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .gte("bounced_at", weekAgo)
      .is("deleted_at", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("channel", "email")
      .eq("direction", "outbound")
      .gte("sent_at", dayAgo)
      .is("deleted_at", null),
    supabase
      .from("batches")
      .select("id", { count: "exact", head: true })
      .eq("gate_status", "failed"),
    getNextAction(supabase),
  ]);

  // Tile-row gate readings. Each reads the same source its workspace uses.
  const [latestSourcingBatch, openBatches, anyBatches, draftPrompt, clayEligible, draftable] =
    await Promise.all([
      supabase
        .from("batch_stats")
        .select("gate_status, sampled, graded, errors")
        .eq("module", "sourcing")
        .neq("label", "legacy")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("batches")
        .select("id", { count: "exact", head: true })
        .eq("gate_status", "open"),
      supabase.from("batches").select("id", { count: "exact", head: true }),
      supabase
        .from("prompt_versions")
        .select("version")
        .eq("module", "drafting")
        .eq("active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      countEligibleContacts(supabase),
      countDraftable(supabase),
    ]);

  // Source gate chip: the latest real sourcing batch's error rate + verdict.
  const sb = latestSourcingBatch.data as {
    gate_status: string;
    sampled: number;
    graded: number;
    errors: number;
  } | null;
  const sourceChip: Step["chip"] = !sb
    ? { text: "gate —", tone: "muted" }
    : sb.graded > 0
      ? {
          text: `gate: ${Math.round((sb.errors / sb.graded) * 100)}% error · ${
            sb.gate_status === "passed" ? "passing" : sb.gate_status
          }`,
          tone: sb.gate_status === "failed" ? "warn" : "ok",
        }
      : { text: `gate: open · 0/${sb.sampled} graded`, tone: "muted" };

  const failedBatchCount = failedBatches.count ?? 0;
  const openBatchCount = openBatches.count ?? 0;
  const gradeChip: Step["chip"] =
    failedBatchCount > 0
      ? { text: `${failedBatchCount} batch${failedBatchCount === 1 ? "" : "es"} failed`, tone: "warn" }
      : openBatchCount > 0
        ? { text: `${openBatchCount} batch${openBatchCount === 1 ? "" : "es"} open`, tone: "muted" }
        : (anyBatches.count ?? 0) > 0
          ? { text: "all batches passed", tone: "ok" }
          : { text: "gate —", tone: "muted" };

  // Review & Enrich shares one card: prefer "to review", else show Clay backlog.
  const reviewCount = toReview.count ?? 0;
  const enrichCount = pendingEnrich.count ?? 0;
  const reviewCardCount = reviewCount > 0 ? reviewCount : enrichCount > 0 ? enrichCount : null;
  const reviewCardNoun = reviewCount > 0 ? "to review" : "pending Clay";

  const sentToday = sent24h.count ?? 0;
  const health: HealthChip[] = [
    {
      href: "/triage",
      label: "untriaged replies",
      value: String(untriaged.count ?? 0),
      alert: (untriaged.count ?? 0) > 0,
    },
    {
      href: "/triage",
      label: "pending suppressions",
      value: String(pendingSuppressions.count ?? 0),
      alert: (pendingSuppressions.count ?? 0) > 0,
    },
    {
      // /draft/queue only lists planned drafts, so failed touches would be
      // invisible there; Outcomes is the surface that renders send results.
      href: "/outcomes",
      label: "failed sends",
      value: String(failedSends.count ?? 0),
      alert: (failedSends.count ?? 0) > 0,
    },
    {
      href: "/outcomes",
      label: "bounces · 7d",
      value: String(bounced7d.count ?? 0),
      alert: (bounced7d.count ?? 0) > 0,
    },
    {
      href: "/draft/queue",
      label: "emails · 24h",
      value: `${sentToday}/${emailCap}`,
      alert: sentToday >= emailCap,
    },
    {
      href: "/runs",
      label: "failed batches",
      value: String(failedBatches.count ?? 0),
      alert: (failedBatches.count ?? 0) > 0,
    },
  ];

  const steps: Step[] = [
    {
      href: "/source",
      step: 1,
      label: "Source",
      icon: Radar,
      blurb: "Find companies that use an MSP and import them.",
      count: null,
      countNoun: "",
      chip: sourceChip,
    },
    {
      href: "/review",
      step: 2,
      label: "Review & Enrich",
      icon: ClipboardCheck,
      blurb: "Vet contacts, then push them to Clay for work emails.",
      count: reviewCardCount,
      countNoun: reviewCardNoun,
      chip:
        clayEligible > 0
          ? { text: `${clayEligible} eligible for Clay`, tone: "ok" }
          : { text: "none eligible for Clay", tone: "muted" },
    },
    {
      href: "/review/grade",
      step: 3,
      label: "Grade",
      icon: GraduationCap,
      blurb: "Grade the sampled rows so a batch can clear the gate.",
      count: awaitingGrade.count ?? null,
      countNoun: "awaiting grade",
      chip: gradeChip,
    },
    {
      href: "/draft",
      step: 4,
      label: "Draft",
      icon: PenLine,
      blurb: "Write outreach for contacts whose batch has passed.",
      count: draftable,
      countNoun: "ready to draft",
      chip: draftPrompt.data
        ? { text: `prompt v${draftPrompt.data.version} live`, tone: "ok" }
        : { text: "prompt —", tone: "muted" },
    },
    {
      href: "/draft/queue",
      step: 5,
      label: "Send",
      icon: Send,
      blurb: "Approve and send the queued outreach touches.",
      count: inQueue.count ?? null,
      countNoun: "awaiting approval",
      chip: {
        text: `${sentToday}/${emailCap} sent · 24h`,
        tone: sentToday >= emailCap ? "warn" : "muted",
      },
    },
    {
      href: "/triage",
      step: 6,
      label: "Triage",
      icon: Inbox,
      blurb: "Disposition every reply; opt-outs become suppressions.",
      count: untriaged.count ?? null,
      countNoun: "untriaged",
      chip:
        (pendingSuppressions.count ?? 0) > 0
          ? { text: `${pendingSuppressions.count} suppression${pendingSuppressions.count === 1 ? "" : "s"} pending`, tone: "warn" }
          : (untriaged.count ?? 0) > 0
            ? { text: "replies waiting", tone: "muted" }
            : { text: "inbox clear", tone: "ok" },
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Up next picks your highest-leverage move; the tiles show what&rsquo;s waiting at each
          stage and whether its gate is healthy.
        </p>
      </div>

      {/* Next best action: one obvious thing to do, derived from pipeline state. */}
      <Card className="flex-row items-center gap-5 border-primary/30 bg-primary/5 px-5 py-4">
        {next.step !== null && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-base font-semibold text-primary-foreground tabular-nums">
            {next.step}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Up next
          </span>
          <span className="font-medium">{next.headline}</span>
          <p className="text-xs leading-relaxed text-muted-foreground">{next.detail}</p>
        </div>
        <Button className="ml-auto shrink-0" nativeButton={false} render={<Link href={next.href} />}>
          {next.cta}
          <ArrowRight className="size-4" />
        </Button>
      </Card>

      {/* Health strip: the numbers that should stay at zero (or under the cap). */}
      <div>
        <p className="px-1 pb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Health
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {health.map((c) => (
            <Link
              key={c.label}
              href={c.href}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                c.alert
                  ? "border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10"
                  : "border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <span className="font-semibold tabular-nums">{c.value}</span>
              <span>{c.label}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.href} href={s.href} className="group">
              <Card className="h-full justify-between gap-5 px-5 transition-shadow group-hover:shadow-elev-2">
                <div className="flex items-start justify-between">
                  <span className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-sm font-semibold text-primary-foreground tabular-nums">
                    {s.step}
                  </span>
                  <Icon className="size-5 text-muted-foreground" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{s.label}</span>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.blurb}</p>
                </div>
                <div className="flex flex-col gap-2.5">
                  <span
                    className={cn(
                      "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[0.68rem] tabular-nums",
                      s.chip.tone === "warn"
                        ? "border-destructive/40 bg-destructive/5 text-destructive"
                        : s.chip.tone === "ok"
                          ? "border-primary/40 bg-primary/5 text-primary"
                          : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {s.chip.text}
                  </span>
                  <div className="flex items-center justify-between">
                    {s.count !== null ? (
                      <span className="text-sm">
                        <span className="font-semibold tabular-nums">{s.count}</span>{" "}
                        <span className="text-muted-foreground">{s.countNoun}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Open</span>
                    )}
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* The outer loop, spelled out. Static explainer for now; each clause
          becomes a live link into Outcomes as the data behind it arrives. */}
      <Card className="flex-row items-start gap-4 border-border/60 bg-muted/30 px-5 py-4">
        <RotateCcw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Outer loop:</span> triaged replies become
          dispositions on Outcomes (per prompt version × audience) and steer the next drafting
          prompt revision · bounces roll up per enrichment cohort and set how much to trust the
          Clay waterfall · grade corrections grow the eval set that future prompts learn from.
          Learning lands in tables, not in anyone&rsquo;s head.
        </p>
      </Card>

      <div>
        <p className="px-1 pb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Data
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/runs" className="group">
            <Card className="flex-row items-center gap-4 px-5 py-4 transition-shadow group-hover:shadow-elev-2">
              <Activity className="size-5 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="font-medium">Runs</span>
                <span className="text-xs text-muted-foreground">
                  Batches, funnel metrics, and gate status.
                </span>
              </div>
              <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Card>
          </Link>
          <Link href="/msps" className="group">
            <Card className="flex-row items-center gap-4 px-5 py-4 transition-shadow group-hover:shadow-elev-2">
              <Building2 className="size-5 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="font-medium">MSPs</span>
                <span className="text-xs text-muted-foreground">
                  Acquisition targets and their customer counts.
                </span>
              </div>
              <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Card>
          </Link>
        </div>
      </div>
    </div>
  );
}
