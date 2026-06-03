// Shared types for the import flow. Kept out of the "use server" module so that
// module can export only async actions (a Next.js requirement).

export type ImportKind = "msp" | "customer";

export type ImportReport = {
  ok: boolean;
  error?: string;
  inserted: { organizations: number; contacts: number };
  flagged: number; // orgs with low confidence or a missing domain
  skippedDuplicates: number;
  messages: string[];
};

export const EMPTY_REPORT: ImportReport = {
  ok: true,
  inserted: { organizations: 0, contacts: 0 },
  flagged: 0,
  skippedDuplicates: 0,
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
  estimated_msp: string | null;
};
