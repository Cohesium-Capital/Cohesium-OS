import { createClient } from "@/lib/supabase/server";
import type { ReviewRow } from "@/lib/sourcing/types";
import { ReviewGrid } from "./review-grid";

// Shape returned by the embedded query (organization is a to-one embed).
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

export default async function ReviewPage() {
  const supabase = await createClient();

  const { data: contacts } = await supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, linkedin_url, confidence, reviewed, enrichment_status, organizations(id, name, domain, current_msp_id)",
    )
    .order("created_at", { ascending: false });

  const rows = (contacts ?? []) as unknown as ContactRow[];

  // Resolve estimated-MSP names in one extra query, then merge in JS (avoids a
  // brittle self-join embed on organizations.current_msp_id).
  const mspIds = [
    ...new Set(rows.map((r) => r.organizations?.current_msp_id).filter(Boolean)),
  ] as string[];
  const mspName = new Map<string, string>();
  if (mspIds.length) {
    const { data: msps } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", mspIds);
    msps?.forEach((m) => mspName.set(m.id, m.name));
  }

  const reviewRows: ReviewRow[] = rows.map((c) => ({
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Review</h1>
        <p className="text-sm text-muted-foreground">
          Sourced contacts. Flagged rows need a look before enrichment.
        </p>
      </div>
      <ReviewGrid initialRows={reviewRows} />
    </div>
  );
}
