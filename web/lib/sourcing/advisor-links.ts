import { nameKey } from "../contracts";
import type { OrgIndex, OrgIndexRow } from "./known";
import type { SourcedTpaLink } from "../contracts";

// The two decisions the advisor import makes that are worth testing on their
// own: which candidates are actually referral partners, and how a payload's
// edges collapse into one row per pair.
//
// Split out of import-core for the same reason identity-merge is split out of
// identity: import-core reaches the database on every path, so nothing inside it
// can be exercised without one, and these two rules are where a quiet mistake
// costs the most — one sends outreach to a company we are trying to buy, the
// other decides how strong we think a referral path is.

/** The match key for a firm name, shared with import-core's org dedupe. */
export const firmKey = (name: string): string =>
  nameKey(name) || `raw:${name.trim().toLowerCase()}`;

export type AdvisorCandidate = {
  name: string;
  domain: string | null;
};

export type AdvisorPartition<T extends AdvisorCandidate> = {
  /** Genuine referral partners: not a company we already hold as a target. */
  partners: T[];
  /** Candidates that ARE a target we hold, with the row they collided with. */
  collisions: { candidate: T; target: OrgIndexRow }[];
};

/**
 * Separate real referral partners from targets filing as their own affiliated
 * firm.
 *
 * This is the trap that costs the most, because both outcomes look identical in
 * the payload. A provider naming ITSELF in the affiliation field arrives looking
 * like a partner; importing it would mint a second row for one company under two
 * kinds, and put a firm we are trying to BUY into a track that asks its owner to
 * refer us to owners like themselves.
 *
 * Domain first, then name — the same precedence the org dedupe uses, so a firm
 * cannot be a duplicate by one rule and a new row by the other.
 */
export function partitionAdvisorCandidates<T extends AdvisorCandidate>(
  targets: OrgIndex,
  candidates: T[],
): AdvisorPartition<T> {
  const partners: T[] = [];
  const collisions: { candidate: T; target: OrgIndexRow }[] = [];
  for (const c of candidates) {
    const target =
      (c.domain ? targets.byDomain.get(c.domain) : undefined) ?? targets.byName.get(nameKey(c.name));
    if (target) collisions.push({ candidate: c, target });
    else partners.push(c);
  }
  return { partners, collisions };
}

export type ResolvedLink = {
  advisorOrgId: string;
  tpaOrgId: string;
  joinSource: "schedule_c" | "schedule_a" | "both";
  sharedPlanCount: number;
  relation: string | null;
};

/**
 * Collapse a payload's edges to one row per (advisor, target) pair.
 *
 * The merge rules encode what the two joins mean. A firm named by BOTH routes is
 * a stronger signal than one named by either alone, so two differing sources
 * become "both" rather than last-write-wins. The plan counts take the maximum
 * rather than the sum: the routes overlap, and adding them would double-count
 * the plans that appear in both and inflate exactly the firms that look
 * strongest.
 *
 * Unresolvable names are returned rather than dropped silently — an advisor
 * naming a target this workspace does not hold is information for the operator,
 * not noise.
 */
export function mergeAdvisorLinks(
  advisorOrgId: string,
  links: SourcedTpaLink[],
  resolveTarget: (name: string) => string | undefined,
): { resolved: ResolvedLink[]; unmatched: string[] } {
  const byPair = new Map<string, ResolvedLink>();
  const unmatched: string[] = [];

  for (const l of links) {
    const tpaOrgId = resolveTarget(l.tpa_name);
    if (!tpaOrgId) {
      if (!unmatched.includes(l.tpa_name)) unmatched.push(l.tpa_name);
      continue;
    }
    // A self-link means the collision guard let a same-company row through under
    // a second spelling. The database rejects it outright, so drop it here
    // rather than failing the whole import on a constraint.
    if (tpaOrgId === advisorOrgId) continue;

    const prior = byPair.get(tpaOrgId);
    byPair.set(tpaOrgId, {
      advisorOrgId,
      tpaOrgId,
      joinSource:
        prior && prior.joinSource !== l.join_source ? "both" : (l.join_source as ResolvedLink["joinSource"]),
      sharedPlanCount: Math.max(prior?.sharedPlanCount ?? 0, l.shared_plan_count),
      relation: l.relation ?? prior?.relation ?? null,
    });
  }

  return { resolved: [...byPair.values()], unmatched };
}
