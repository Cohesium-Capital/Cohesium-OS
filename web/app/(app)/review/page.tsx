import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { ReviewRow } from "@/lib/sourcing/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ReviewGrid, ReviewSelectionProvider } from "./review-grid";
import { PushToClayButton } from "./push-to-clay-button";
import { countEligibleContacts } from "@/lib/enrichment/pending";

type ContactRow = {
  id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  linkedin_url: string | null;
  confidence: string | null;
  reviewed: boolean;
  enrichment_status: string;
  organizations: {
    id: string;
    name: string;
    domain: string | null;
    kind: string | null;
    current_msp_id: string | null;
  } | null;
};

const PAGE_SIZE = 50;

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; flagged?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const flagged = sp.flagged === "1";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  // Inner join on organizations so we can search by company name and paginate
  // server-side (the dataset will outgrow a client-side load). Soft-deleted
  // contacts never appear.
  let query = supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, linkedin_url, confidence, reviewed, enrichment_status, organizations!inner(id, name, domain, kind, current_msp_id)",
      { count: "exact" },
    )
    .is("deleted_at", null);
  if (flagged) query = query.eq("reviewed", false);
  if (q) query = query.ilike("organizations.name", `%${q}%`);
  const { data, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const contacts = (data ?? []) as unknown as ContactRow[];

  // Resolve estimated-MSP names for just this page.
  const mspIds = [
    ...new Set(contacts.map((r) => r.organizations?.current_msp_id).filter(Boolean)),
  ] as string[];
  const mspName = new Map<string, string>();
  if (mspIds.length) {
    const { data: msps } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", mspIds);
    msps?.forEach((m) => mspName.set(m.id, m.name));
  }

  const rows: ReviewRow[] = contacts.map((c) => ({
    id: c.id,
    full_name: c.full_name,
    persona: c.persona,
    title: c.title,
    linkedin_url: c.linkedin_url,
    confidence: c.confidence,
    reviewed: c.reviewed,
    enrichment_status: c.enrichment_status,
    org_name: c.organizations?.name ?? "—",
    org_domain: c.organizations?.domain ?? null,
    org_kind: c.organizations?.kind ?? null,
    estimated_msp: c.organizations?.current_msp_id
      ? mspName.get(c.organizations.current_msp_id) ?? null
      : null,
  }));

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Counts exclude soft-deleted rows. "eligible" is the Clay-push gate:
  // pending AND reviewed AND (no batch or gate-passed batch).
  const [unreviewed, pendingEnrich, enriched, failedEnrich, eligible] =
    await Promise.all([
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("reviewed", false)
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("enrichment_status", "pending")
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("enrichment_status", "enriched")
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .in("enrichment_status", ["failed", "low_confidence"])
        .is("deleted_at", null),
      countEligibleContacts(supabase),
    ]);
  const counts = {
    unreviewed: unreviewed.count ?? 0,
    pending: pendingEnrich.count ?? 0,
    enriched: enriched.count ?? 0,
    failed: failedEnrich.count ?? 0,
    eligible,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Review &amp; Enrich</h1>
        <p className="text-sm text-muted-foreground">
          Two jobs on this page: vet the sourced contacts, then send keepers through Clay so they
          get a work email (and phone / LinkedIn) before drafting.
        </p>
      </div>

      {/* How-to: make the Review → Enrich sequence self-evident. The provider
          bridges the grid's selection to the push button in card B. */}
      <ReviewSelectionProvider>
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                A
              </span>
              Vet the contacts
            </CardTitle>
            <CardDescription>
              Scan the grid below. Flagged / unreviewed rows need a look — check company, title,
              LinkedIn, and estimated MSP. Delete junk; mark keepers as reviewed.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <span className="font-semibold tabular-nums">{counts.unreviewed}</span>{" "}
            <span className="text-muted-foreground">still unreviewed</span>
            {counts.unreviewed > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="ml-3"
                nativeButton={false}
                render={<Link href="/review?flagged=1" />}
              >
                Show unreviewed
              </Button>
            )}
          </CardContent>
        </Card>

        <Card
          data-tour="review-clay"
          className={counts.eligible > 0 ? "border-primary/30 bg-primary/5" : undefined}
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                B
              </span>
              Enrich via Clay
            </CardTitle>
            <CardDescription>
              Clay finds the missing <strong>work email</strong> (plus phone / LinkedIn when it
              can). Enrichment costs credits, so only <strong>reviewed</strong> contacts from
              gate-passed batches are eligible. Select rows in the grid to scope the push, or
              push everything eligible; statuses flip when Clay writes back.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>
                <span className="font-semibold tabular-nums">{counts.pending}</span>{" "}
                <span className="text-muted-foreground">pending</span>
              </span>
              <span>
                <span className="font-semibold tabular-nums">{counts.eligible}</span>{" "}
                <span className="text-muted-foreground">eligible for Clay</span>
              </span>
              <span>
                <span className="font-semibold tabular-nums">{counts.enriched}</span>{" "}
                <span className="text-muted-foreground">enriched</span>
              </span>
              <span>
                <span className="font-semibold tabular-nums">{counts.failed}</span>{" "}
                <span className="text-muted-foreground">failed</span>
              </span>
            </div>
            {counts.eligible > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <PushToClayButton eligibleCount={counts.eligible} />
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/api/enrichment/export" prefetch={false} />}
                >
                  Export eligible CSV for Clay
                </Button>
              </div>
            ) : counts.pending > 0 ? (
              <p className="text-sm text-muted-foreground">
                Pending contacts aren&rsquo;t eligible yet — mark keepers reviewed (step A) and
                make sure their batch has passed{" "}
                <Link href="/review/grade" className="text-foreground underline underline-offset-2">
                  Grade
                </Link>
                .
              </p>
            ) : counts.enriched > 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing pending. Enriched contacts with an address can{" "}
                <Link href="/draft" className="text-foreground underline underline-offset-2">
                  draft (step 5)
                </Link>{" "}
                once their batch passes Grade.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing to enrich yet — finish a sourcing run first.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <ReviewGrid
        key={`${page}|${q}|${flagged ? 1 : 0}`}
        initialRows={rows}
        q={q}
        flagged={flagged}
        page={page}
        pageCount={pageCount}
        total={total}
      />
      </ReviewSelectionProvider>
    </div>
  );
}
