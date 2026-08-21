import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  partitionAdvisorCandidates,
  mergeAdvisorLinks,
  firmKey,
  type ResolvedLink,
} from "./advisor-links";
import type { OrgIndex, OrgIndexRow } from "./known";
import type { SourcedTpaLink } from "../contracts";
import { normalizeDomain, nameKey, SourcingPayloadSchema } from "../contracts";

// Build a target index the way loadOrgIndex does, without a database.
function targetIndex(rows: { id?: string; name: string; domain?: string | null }[]): OrgIndex {
  const full = rows.map((r, i) => ({
    id: r.id ?? `tpa-${i}`,
    name: r.name,
    domain: r.domain ?? null,
    current_msp_id: null,
    hq_city: null,
    hq_state: null,
    source_url: null,
    evidence: null,
    advisor_firm_type: null,
  })) as OrgIndexRow[];
  const byDomain = new Map<string, OrgIndexRow>();
  const byName = new Map<string, OrgIndexRow>();
  const byNameAndMsp = new Map<string, OrgIndexRow>();
  for (const r of full) {
    const d = normalizeDomain(r.domain);
    if (d && !byDomain.has(d)) byDomain.set(d, r);
    const nk = nameKey(r.name);
    if (nk && !byName.has(nk)) byName.set(nk, r);
    byNameAndMsp.set(`${nk}|`, r);
  }
  return { kind: "msp", rows: full, byDomain, byName, byNameAndMsp };
}

const link = (over: Partial<SourcedTpaLink> & { tpa_name: string }): SourcedTpaLink => ({
  join_source: "schedule_c",
  shared_plan_count: 0,
  relation: null,
  source_url: null,
  ...over,
});

const byTarget = (resolved: ResolvedLink[]) =>
  new Map(resolved.map((r) => [r.tpaOrgId, r]));

describe("partitionAdvisorCandidates", () => {
  test("a firm we already hold as a target is a collision, not a partner", () => {
    // The Orenda case: a provider filing as its own broker of record. Importing
    // it would put a company we are trying to buy into the referral track.
    const index = targetIndex([{ id: "t-1", name: "Orenda Retirement Group" }]);
    const { partners, collisions } = partitionAdvisorCandidates(index, [
      { name: "Orenda Retirement Group", domain: null },
      { name: "Keel Point Advisory", domain: "keelpoint.example" },
    ]);
    assert.deepEqual(partners.map((p) => p.name), ["Keel Point Advisory"]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].target.id, "t-1");
  });

  test("collides on legal-suffix and article variants, like the org dedupe does", () => {
    const index = targetIndex([{ name: "The Retirement Advantage Inc" }]);
    const { partners, collisions } = partitionAdvisorCandidates(index, [
      { name: "Retirement Advantage, LLC", domain: null },
    ]);
    assert.equal(partners.length, 0);
    assert.equal(collisions.length, 1);
  });

  test("domain wins over name, so a renamed firm still collides", () => {
    const index = targetIndex([{ id: "t-9", name: "Nova Plan Services", domain: "nova401k.com" }]);
    const { collisions } = partitionAdvisorCandidates(index, [
      { name: "Completely Different Advisory", domain: "nova401k.com" },
    ]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].target.id, "t-9");
  });

  test("similar-but-distinct names do NOT collide", () => {
    // The name-matching trap: dropping industry words makes these one firm.
    // They are two, and treating them as one would silently suppress a real
    // referral partner.
    const index = targetIndex([{ name: "National Benefit Services" }]);
    const { partners, collisions } = partitionAdvisorCandidates(index, [
      { name: "National Retirement Services", domain: null },
    ]);
    assert.equal(collisions.length, 0);
    assert.deepEqual(partners.map((p) => p.name), ["National Retirement Services"]);
  });
});

describe("mergeAdvisorLinks", () => {
  const resolve = (name: string) =>
    ({ [firmKey("Nova Plan Services")]: "t-nova", [firmKey("Cedar Ridge")]: "t-cedar" })[
      firmKey(name)
    ];

  test("a pair named by both routes becomes 'both', not last-write-wins", () => {
    // The headline rule: Schedule C and Schedule A overlap on under 10% of
    // firms, so appearing in both is a genuinely stronger signal.
    const { resolved } = mergeAdvisorLinks(
      "a-1",
      [
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_c", shared_plan_count: 4 }),
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_a", shared_plan_count: 6 }),
      ],
      resolve,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].joinSource, "both");
  });

  test("plan counts take the max, never the sum", () => {
    // The routes overlap, so adding them double-counts exactly the plans that
    // appear in both — inflating the firms that already look strongest.
    const { resolved } = mergeAdvisorLinks(
      "a-1",
      [
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_c", shared_plan_count: 4 }),
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_a", shared_plan_count: 6 }),
      ],
      resolve,
    );
    assert.equal(resolved[0].sharedPlanCount, 6);
  });

  test("the same route twice stays that route", () => {
    const { resolved } = mergeAdvisorLinks(
      "a-1",
      [
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_c", shared_plan_count: 2 }),
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_c", shared_plan_count: 9 }),
      ],
      resolve,
    );
    assert.equal(resolved[0].joinSource, "schedule_c");
    assert.equal(resolved[0].sharedPlanCount, 9);
  });

  test("distinct targets stay distinct", () => {
    const { resolved } = mergeAdvisorLinks(
      "a-1",
      [
        link({ tpa_name: "Nova Plan Services", shared_plan_count: 3 }),
        link({ tpa_name: "Cedar Ridge", shared_plan_count: 11 }),
      ],
      resolve,
    );
    assert.equal(resolved.length, 2);
    assert.equal(byTarget(resolved).get("t-cedar")?.sharedPlanCount, 11);
  });

  test("a target we do not hold is reported, not invented", () => {
    // No stub creation on this path: an advisor naming an unknown provider has
    // only told us it works somewhere we do not operate.
    const { resolved, unmatched } = mergeAdvisorLinks(
      "a-1",
      [link({ tpa_name: "Somewhere We Do Not Hold" }), link({ tpa_name: "Nova Plan Services" })],
      resolve,
    );
    assert.deepEqual(unmatched, ["Somewhere We Do Not Hold"]);
    assert.equal(resolved.length, 1);
  });

  test("the same unresolvable name is reported once", () => {
    const { unmatched } = mergeAdvisorLinks(
      "a-1",
      [link({ tpa_name: "Unknown Admin" }), link({ tpa_name: "Unknown Admin" })],
      resolve,
    );
    assert.deepEqual(unmatched, ["Unknown Admin"]);
  });

  test("a self-link is dropped rather than left to fail the whole import", () => {
    const { resolved } = mergeAdvisorLinks(
      "t-nova",
      [link({ tpa_name: "Nova Plan Services" })],
      resolve,
    );
    assert.deepEqual(resolved, []);
  });

  test("a relation string survives a merge that has none", () => {
    const { resolved } = mergeAdvisorLinks(
      "a-1",
      [
        link({ tpa_name: "Nova Plan Services", relation: "INVESTMENT ADVISOR" }),
        link({ tpa_name: "Nova Plan Services", join_source: "schedule_a", relation: null }),
      ],
      resolve,
    );
    assert.equal(resolved[0].relation, "INVESTMENT ADVISOR");
  });

  test("no links means no rows and nothing unmatched", () => {
    const { resolved, unmatched } = mergeAdvisorLinks("a-1", [], resolve);
    assert.deepEqual(resolved, []);
    assert.deepEqual(unmatched, []);
  });
});

describe("the advisor ingest payload", () => {
  // The exact shape documented in tenants/ilium/skills/source-advisors/SKILL.md.
  // Nothing else tests that the skill and the contract agree, and a runner
  // following a stale doc gets a 422 with no clue which field moved.
  const documented = {
    organizations: [
      {
        name: "Keel Point Advisory",
        domain: "keelpoint.example",
        hq_city: null,
        hq_state: null,
        advisor_firm_type: "fee_based_practice",
        source_url: "https://keelpoint.example/about",
        confidence: "high",
        tpa_links: [
          {
            tpa_name: "Nova 401(k) Associates",
            join_source: "both",
            shared_plan_count: 14,
            relation: "INVESTMENT ADVISOR",
            source_url: "https://efast.dol.gov/…",
          },
        ],
        contacts: [
          {
            full_name: "Dana Whitfield",
            persona: "owner",
            title: "Managing Principal",
            linkedin_url: "https://www.linkedin.com/in/example",
            source_url: "https://keelpoint.example/team",
            confidence: "high",
          },
        ],
      },
    ],
  };

  test("parses exactly as the runner skill documents it", () => {
    const parsed = SourcingPayloadSchema.parse(documented);
    const org = parsed.organizations[0];
    assert.equal(org.advisor_firm_type, "fee_based_practice");
    assert.equal(org.tpa_links[0].join_source, "both");
    assert.equal(org.tpa_links[0].shared_plan_count, 14);
    assert.equal(org.contacts[0].persona, "owner");
  });

  test("an msp/customer payload still parses with no tpa_links", () => {
    // The advisor fields are additive: the other two modes send neither, and
    // must keep working unchanged.
    const parsed = SourcingPayloadSchema.parse({
      organizations: [{ name: "Northlake Logistics", current_msp_name: "Harbor IT" }],
    });
    // tpa_links has a default, so it is always an array. advisor_firm_type is
    // `nullish`, so an absent key stays undefined — import-core coalesces it,
    // and asserting a specific flavour of empty here would pin zod's behaviour
    // rather than the contract.
    assert.deepEqual(parsed.organizations[0].tpa_links, []);
    assert.ok(parsed.organizations[0].advisor_firm_type == null);
  });

  test("a quoted plan count is coerced rather than failing the row", () => {
    const parsed = SourcingPayloadSchema.parse({
      organizations: [
        {
          name: "Fairlane Benefits Group",
          tpa_links: [{ tpa_name: "Nova 401(k) Associates", shared_plan_count: "7" }],
        },
      ],
    });
    assert.equal(parsed.organizations[0].tpa_links[0].shared_plan_count, 7);
    // Unspecified route defaults to the fee-based one, matching the contract.
    assert.equal(parsed.organizations[0].tpa_links[0].join_source, "schedule_c");
  });

  test("a garbage join_source falls back instead of rejecting the payload", () => {
    const parsed = SourcingPayloadSchema.parse({
      organizations: [
        {
          name: "Fairlane Benefits Group",
          tpa_links: [{ tpa_name: "Nova 401(k) Associates", join_source: "schedule_q" }],
        },
      ],
    });
    assert.equal(parsed.organizations[0].tpa_links[0].join_source, "schedule_c");
  });

  test("a link with no tpa_name is a hard failure, not a silent default", () => {
    // Everything else on this path fails soft. This one cannot: an edge with no
    // target is not an edge, and defaulting it would invent a relationship.
    assert.throws(() =>
      SourcingPayloadSchema.parse({
        organizations: [{ name: "Fairlane Benefits Group", tpa_links: [{ tpa_name: "" }] }],
      }),
    );
  });
});
