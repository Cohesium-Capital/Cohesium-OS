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
import { countAlreadyPushed, countEligibleContacts } from "@/lib/enrichment/pending";
import { contactRunMap, loadRunScope } from "@/lib/runs/scope";
import { currentWorkspaceId } from "@/lib/workspace/context";
import { RunScopeBanner } from "@/components/run-scope-banner";

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

// A uuid that matches nothing, for "scoped to a run that produced no records".
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    needs_review?: string;
    flagged?: string;
    run?: string;
  }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  // `flagged=1` is the old name for this filter — still honoured so existing
  // bookmarks keep working.
  const needsReviewOnly = sp.needs_review === "1" || sp.flagged === "1";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();

  // Arriving from a run's timeline entry scopes the grid to that run's records.
  const scope = await loadRunScope(supabase, sp.run ?? null);

  // Inner join on organizations so we can search by company name and paginate
  // server-side (the dataset will outgrow a client-side load). Soft-deleted
  // contacts never appear.
  let query = supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, linkedin_url, confidence, reviewed, enrichment_status, organizations!inner(id, name, domain, kind, current_msp_id)",
      { count: "exact" },
    )
    .is("deleted_at", null)
    .eq("workspace_id", workspaceId);
  if (needsReviewOnly) query = query.eq("reviewed", false);
  if (q) query = query.ilike("organizations.name", `%${q}%`);
  // An empty scope is still a scope: a run with no records shows no rows rather
  // than silently falling back to every contact in the database.
  if (scope) query = query.in("id", scope.contactIds.length ? scope.contactIds : [NO_MATCH]);
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

  // Run identifier + date per contact on this page, for the Run / Run date
  // columns. Scoped to the page's rows, so this stays one small lookup.
  const runInfo = await contactRunMap(
    supabase,
    contacts.map((c) => c.id),
  );

  const rows: ReviewRow[] = contacts.map((c) => ({
    id: c.id,
    run_code: runInfo.get(c.id)?.code ?? null,
    run_id: runInfo.get(c.id)?.runId ?? null,
    run_at: runInfo.get(c.id)?.runAt ?? null,
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
  // pending AND reviewed AND (no batch or gate-passed batch) AND never sent.
  // "alreadySent" is the set that clears every bar except the last — shown so
  // the contacts the double-spend guard holds back are visible rather than
  // silently missing from the eligible count.
  const [unreviewed, pendingEnrich, enriched, failedEnrich, eligible, alreadySent] =
    await Promise.all([
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("reviewed", false)
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("enrichment_status", "pending")
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("enrichment_status", "enriched")
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("enrichment_status", ["failed", "low_confidence"])
        .is("deleted_at", null),
      countEligibleContacts(supabase, workspaceId),
      countAlreadyPushed(supabase, workspaceId),
    ]);
  const counts = {
    unreviewed: unreviewed.count ?? 0,
    pending: pendingEnrich.count ?? 0,
    enriched: enriched.count ?? 0,
    failed: failedEnrich.count ?? 0,
    eligible,
    alreadySent,
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

      <RunScopeBanner scope={scope} basePath="/review" noun="contacts" />

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
              Every sourced contact arrives marked{" "}
              <span className="font-medium text-amber-600">Needs review</span> — that means
              nobody has checked it yet, not that anything looks wrong with it. Open the row,
              check company, title, LinkedIn and estimated provider, then delete the junk and mark
              the keepers reviewed. Only reviewed contacts can be enriched in step B.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <span className="font-semibold tabular-nums">{counts.unreviewed}</span>{" "}
            <span className="text-muted-foreground">still need review</span>
            {counts.unreviewed > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="ml-3"
                nativeButton={false}
                render={<Link href="/review?needs_review=1" />}
              >
                Show them
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
              gate-passed batches that have <strong>never been sent before</strong> are
              eligible. Select rows in the grid to scope the push, or push everything eligible;
              statuses flip when Clay writes back.
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
              {counts.alreadySent > 0 && (
                <span>
                  <span className="font-semibold tabular-nums">{counts.alreadySent}</span>{" "}
                  <span className="text-muted-foreground">already sent (no write-back yet)</span>
                </span>
              )}
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
                <PushToClayButton
                  eligibleCount={counts.eligible}
                  alreadySentCount={counts.alreadySent}
                />
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/api/enrichment/export" prefetch={false} />}
                >
                  Export eligible CSV for Clay
                </Button>
              </div>
            ) : counts.alreadySent > 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing new to send — the {counts.alreadySent} pending contact
                {counts.alreadySent === 1 ? " has" : "s have"} already been through Clay and
                {counts.alreadySent === 1 ? " is" : " are"} waiting on a write-back. Sending
                again spends credits for a second time; only do it if the first send genuinely
                didn&rsquo;t land.
              </p>
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
        key={`${page}|${q}|${needsReviewOnly ? 1 : 0}|${scope?.runId ?? ""}`}
        initialRows={rows}
        q={q}
        needsReviewOnly={needsReviewOnly}
        runId={scope?.runId ?? null}
        page={page}
        pageCount={pageCount}
        total={total}
      />
      </ReviewSelectionProvider>
    </div>
  );
}
