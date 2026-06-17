import Link from "next/link";
import {
  Radar,
  ClipboardCheck,
  GraduationCap,
  PenLine,
  Send,
  Activity,
  Building2,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";

// Home = the pipeline at a glance. Steps render in workflow order with a live
// count of what's waiting at each stage, so the next thing to do is obvious and
// one click away. This replaces the old redirect-to-/review.

type Step = {
  href: string;
  step: number;
  label: string;
  icon: LucideIcon;
  blurb: string;
  count: number | null;
  countNoun: string;
};

export default async function HomePage() {
  const supabase = await createClient();

  const [toReview, awaitingGrade, inQueue] = await Promise.all([
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("reviewed", false),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("sampled", true)
      .eq("review_status", "pending_review")
      .not("batch_id", "is", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("status", "planned")
      .eq("direction", "outbound"),
  ]);

  const steps: Step[] = [
    {
      href: "/source",
      step: 1,
      label: "Source",
      icon: Radar,
      blurb: "Find companies that use an MSP and import them.",
      count: null,
      countNoun: "",
    },
    {
      href: "/review",
      step: 2,
      label: "Review",
      icon: ClipboardCheck,
      blurb: "Vet sourced contacts and send them to enrichment.",
      count: toReview.count ?? null,
      countNoun: "to review",
    },
    {
      href: "/review/grade",
      step: 3,
      label: "Grade",
      icon: GraduationCap,
      blurb: "Grade the sampled rows so a batch can clear the gate.",
      count: awaitingGrade.count ?? null,
      countNoun: "awaiting grade",
    },
    {
      href: "/draft",
      step: 4,
      label: "Draft",
      icon: PenLine,
      blurb: "Write outreach for contacts whose batch has passed.",
      count: null,
      countNoun: "",
    },
    {
      href: "/draft/queue",
      step: 5,
      label: "Send",
      icon: Send,
      blurb: "Approve and send the queued outreach touches.",
      count: inQueue.count ?? null,
      countNoun: "queued",
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Pipeline</h1>
        <p className="text-sm text-muted-foreground">
          From sourcing to send — work each stage left to right.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
              </Card>
            </Link>
          );
        })}
      </div>

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
