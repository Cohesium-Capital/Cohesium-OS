import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDomain, nameKey } from "../contracts";
import type { ImportKind } from "./types";

// "Do we already have this company?" — the single matching rule, shared by the
// ingest dedupe (import-core) and the runner's candidate filter
// (/api/sourcing/known).
//
// Two callers, one rule, on purpose: if the filter and the ingest disagreed, the
// runner would either research companies ingest then discards as duplicates
// (the waste we are removing) or skip companies ingest would have accepted (a
// silent coverage hole). Keeping the index and the key function here makes that
// disagreement impossible.

export type OrgIndexRow = {
  id: string;
  name: string;
  domain: string | null;
  current_msp_id: string | null;
  hq_city: string | null;
  hq_state: string | null;
  source_url: string | null;
  evidence: { url?: string; via?: string }[] | null;
  /** Advisor rows only (048): the classifier's verdict, null until one runs. */
  advisor_firm_type: string | null;
};

// PostgREST caps an unbounded select at its max-rows setting (Supabase defaults
// to ~1000) with no error. An org table past that cap would silently stop
// matching — the dedupe would "work" while quietly admitting duplicates for
// every org beyond the first page. Page explicitly, advancing by rows actually
// returned so it stays correct if the server cap is below our page size.
const PAGE = 1000;

const SELECT =
  "id, name, domain, current_msp_id, hq_city, hq_state, source_url, evidence, advisor_firm_type";

export type OrgIndex = {
  kind: ImportKind;
  rows: OrgIndexRow[];
  /** normalized domain -> org */
  byDomain: Map<string, OrgIndexRow>;
  /** nameKey -> org, ignoring MSP linkage */
  byName: Map<string, OrgIndexRow>;
  /** `nameKey|current_msp_id` -> org, the ingest row-identity key for customers */
  byNameAndMsp: Map<string, OrgIndexRow>;
};

/**
 * Load every organization of a kind IN ONE WORKSPACE, paged, and index it for
 * matching.
 *
 * The workspace filter is not optional. RLS scopes to every workspace the
 * caller belongs to, so without it a multi-workspace user's index would span
 * tenants — the ingest would then "merge" a new company into another
 * workspace's row (mutating data the current workspace shouldn't touch, and
 * never giving this workspace its own copy), and the /known check would
 * suppress researching companies only some OTHER workspace holds.
 */
export async function loadOrgIndex(
  supabase: SupabaseClient,
  kind: ImportKind,
  workspaceId: string,
): Promise<OrgIndex> {
  const rows: OrgIndexRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("organizations")
      .select(SELECT)
      .eq("workspace_id", workspaceId)
      .eq("kind", kind)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not load existing organizations: ${error.message}`);
    const page = (data ?? []) as unknown as OrgIndexRow[];
    rows.push(...page);
    if (page.length < PAGE) break; // short page = last page
    from += page.length;
  }

  const byDomain = new Map<string, OrgIndexRow>();
  const byName = new Map<string, OrgIndexRow>();
  const byNameAndMsp = new Map<string, OrgIndexRow>();
  for (const r of rows) {
    const domain = normalizeDomain(r.domain);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, r);
    const nk = nameKey(r.name);
    if (nk && !byName.has(nk)) byName.set(nk, r);
    const scoped = `${nk}|${r.current_msp_id ?? ""}`;
    if (!byNameAndMsp.has(scoped)) byNameAndMsp.set(scoped, r);
  }
  return { kind, rows, byDomain, byName, byNameAndMsp };
}

export type Candidate = { name: string; domain?: string | null };

export type CandidateVerdict = {
  name: string;
  domain: string | null;
  known: boolean;
  /** why it matched: the existing org's name, so the operator can sanity-check */
  matched?: string;
  matchedOn?: "domain" | "name";
};

/**
 * Partition candidates into already-held and genuinely new.
 *
 * `mspId` scopes the question for the find-customers-for-a-specific-MSP mode:
 * there, a company only counts as known if we already record it as a client of
 * *that* MSP, because the same company under a different MSP is a real find.
 *
 * With no `mspId` the question is the broader "do we hold this company at all",
 * which is deliberately stricter than the ingest's row-identity key: for plain
 * customer research we don't want to spend a search on a company we already
 * have, regardless of which MSP it happens to be attached to.
 */
export function partitionCandidates(
  index: OrgIndex,
  candidates: Candidate[],
  opts?: { mspId?: string | null },
): { known: CandidateVerdict[]; fresh: CandidateVerdict[] } {
  const known: CandidateVerdict[] = [];
  const fresh: CandidateVerdict[] = [];

  // Candidates can repeat within one payload; collapse them so a duplicate name
  // is not researched twice inside a single run either.
  const seen = new Set<string>();

  for (const c of candidates) {
    const domain = normalizeDomain(c.domain);
    const nk = nameKey(c.name);
    const dedupeKey = domain ? `d:${domain}` : `n:${nk}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let match: OrgIndexRow | undefined;
    let matchedOn: "domain" | "name" | undefined;
    if (domain) {
      match = index.byDomain.get(domain);
      if (match) matchedOn = "domain";
    }
    if (!match && nk) {
      match = opts?.mspId
        ? index.byNameAndMsp.get(`${nk}|${opts.mspId}`)
        : index.byName.get(nk);
      if (match) matchedOn = "name";
    }

    // A domain hit is decisive, but a name hit under an MSP scope must belong to
    // that MSP — otherwise "Acme Dental, client of MSP A" would wrongly suppress
    // researching "Acme Dental, client of MSP B".
    if (match && opts?.mspId && matchedOn === "domain" && match.current_msp_id !== opts.mspId) {
      match = undefined;
      matchedOn = undefined;
    }

    const verdict: CandidateVerdict = {
      name: c.name,
      domain,
      known: !!match,
      ...(match ? { matched: match.name, matchedOn } : {}),
    };
    (match ? known : fresh).push(verdict);
  }

  return { known, fresh };
}
