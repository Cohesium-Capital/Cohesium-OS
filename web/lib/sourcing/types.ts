// Shared types for the import flow. Kept out of the "use server" module so that
// module can export only async actions (a Next.js requirement).

export type ImportKind = "msp" | "customer" | "advisor";

export type ImportReport = {
  ok: boolean;
  error?: string;
  inserted: { organizations: number; contacts: number };
  merged: number; // existing orgs enriched (matched, not re-inserted)
  needsChecking: number; // orgs with low confidence or a missing domain
  skippedDuplicates: number; // intra-payload duplicates collapsed
  rejected: number; // evidence-less rows logged to rejected_ingest (run path)
  sampledCount: number; // inserted contacts selected for grading
  batchId?: string | null; // batch the run's records were written into
  // Advisor imports only (048).
  advisorLinks: number; // advisor -> TPA edges written or refreshed
  advisorLinksUnmatched: number; // named a TPA this workspace does not hold
  advisorIsTpa: number; // advisor firm is already an acquisition target — held, not inserted
  messages: string[];
};

export const EMPTY_REPORT: ImportReport = {
  ok: true,
  inserted: { organizations: 0, contacts: 0 },
  merged: 0,
  needsChecking: 0,
  skippedDuplicates: 0,
  rejected: 0,
  sampledCount: 0,
  advisorLinks: 0,
  advisorLinksUnmatched: 0,
  advisorIsTpa: 0,
  messages: [],
};

// One flattened contact row for the review grid: the contact, its organization,
// and the organization's estimated MSP. Reused by the later send screen.
export type ReviewRow = {
  id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  linkedin_url: string | null;
  confidence: string | null;
  reviewed: boolean;
  enrichment_status: string;
  org_name: string;
  org_domain: string | null;
  org_kind: string | null; // 'msp' (acquisition target) | 'customer' | 'advisor' | 'unknown' (legacy default)
  estimated_msp: string | null;
  // Which run produced this record (migration 024). Null only for rows with no
  // resolvable lineage — legacy direct imports carry neither run nor batch.
  run_code: string | null;
  run_id: string | null;
  run_at: string | null;
};
