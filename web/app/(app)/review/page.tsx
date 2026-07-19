import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { ReviewRow } from "@/lib/sourcing/types";
import { Button } from "@/components/ui/button";
import { ReviewGrid } from "./review-grid";

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
  // server-side (the dataset will outgrow a client-side load).
  let query = supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, linkedin_url, confidence, reviewed, enrichment_status, organizations!inner(id, name, domain, current_msp_id)",
      { count: "exact" },
    );
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
    estimated_msp: c.organizations?.current_msp_id
      ? mspName.get(c.organizations.current_msp_id) ?? null
      : null,
  }));

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Enrichment progress across ALL contacts (not just this page), so the
  // Clay round-trip is visible as a pipeline stage instead of two mystery
  // buttons: pending → (Clay) → enriched/failed.
  const [pendingEnrich, enriched, failedEnrich] = await Promise.all([
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "pending"),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "enriched"),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .in("enrichment_status", ["failed", "low_confidence"]),
  ]);
  const enrichCounts = {
    pending: pendingEnrich.count ?? 0,
    enriched: enriched.count ?? 0,
    failed: failedEnrich.count ?? 0,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="text-sm text-muted-foreground">
            Sourced contacts. Flagged rows need a look before enrichment.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/enrich" />}>
          Enrichment (step 4) →
        </Button>
      </div>

      {/* Enrichment progress at a glance; the actions live on /enrich. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2.5 text-sm">
        <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Enrichment
        </span>
        <span>
          <span className="font-semibold tabular-nums">{enrichCounts.pending}</span>{" "}
          <span className="text-muted-foreground">pending</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{enrichCounts.enriched}</span>{" "}
          <span className="text-muted-foreground">enriched</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{enrichCounts.failed}</span>{" "}
          <span className="text-muted-foreground">failed / low-confidence</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {enrichCounts.pending > 0 ? (
            <>
              <Link href="/enrich" className="text-foreground underline underline-offset-2">
                Send pending to Clay (step 4)
              </Link>{" "}
              — rows flip to enriched when Clay writes back.
            </>
          ) : enrichCounts.enriched > 0 ? (
            <>
              Enriched contacts are ready to{" "}
              <Link href="/draft" className="text-foreground underline underline-offset-2">
                draft (step 5)
              </Link>{" "}
              once their batch passes the gate.
            </>
          ) : (
            <>Nothing to enrich yet — source contacts first.</>
          )}
        </span>
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
    </div>
  );
}
