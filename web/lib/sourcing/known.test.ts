import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { partitionCandidates, type OrgIndex, type OrgIndexRow } from "./known";
import { normalizeDomain, nameKey } from "../contracts";

// Build an index the same way loadOrgIndex does, without a database.
function indexOf(kind: "msp" | "customer", rows: Partial<OrgIndexRow>[]): OrgIndex {
  const full = rows.map((r, i) => ({
    id: r.id ?? `id-${i}`,
    name: r.name ?? "",
    domain: r.domain ?? null,
    current_msp_id: r.current_msp_id ?? null,
    hq_city: null,
    hq_state: null,
    source_url: null,
    evidence: null,
  })) as OrgIndexRow[];
  const byDomain = new Map<string, OrgIndexRow>();
  const byName = new Map<string, OrgIndexRow>();
  const byNameAndMsp = new Map<string, OrgIndexRow>();
  for (const r of full) {
    const d = normalizeDomain(r.domain);
    if (d && !byDomain.has(d)) byDomain.set(d, r);
    const nk = nameKey(r.name);
    if (nk && !byName.has(nk)) byName.set(nk, r);
    const scoped = `${nk}|${r.current_msp_id ?? ""}`;
    if (!byNameAndMsp.has(scoped)) byNameAndMsp.set(scoped, r);
  }
  return { kind, rows: full, byDomain, byName, byNameAndMsp };
}

const names = (v: { name: string }[]) => v.map((x) => x.name).sort();

describe("partitionCandidates", () => {
  test("matches on domain regardless of how the name is written", () => {
    const index = indexOf("customer", [{ name: "Acme Dental Group", domain: "acmedental.com" }]);
    const { known, fresh } = partitionCandidates(index, [
      { name: "Totally Different Name", domain: "https://www.acmedental.com/about" },
    ]);
    assert.equal(fresh.length, 0);
    assert.equal(known[0].matchedOn, "domain");
    assert.equal(known[0].matched, "Acme Dental Group");
  });

  test("matches on name through legal suffixes and punctuation", () => {
    const index = indexOf("customer", [{ name: "PBI Performance Products, Inc." }]);
    const { known, fresh } = partitionCandidates(index, [{ name: "PBI Performance Products" }]);
    assert.equal(fresh.length, 0);
    assert.equal(known[0].matchedOn, "name");
  });

  test("genuinely new companies come back as new", () => {
    const index = indexOf("customer", [{ name: "Acme Dental", domain: "acmedental.com" }]);
    const { known, fresh } = partitionCandidates(index, [
      { name: "Barton Legal", domain: "bartonlegal.com" },
      { name: "Vega Foods" },
    ]);
    assert.equal(known.length, 0);
    assert.deepEqual(names(fresh), ["Barton Legal", "Vega Foods"]);
  });

  test("collapses duplicates within one request so nothing is researched twice", () => {
    const index = indexOf("customer", []);
    const { fresh } = partitionCandidates(index, [
      { name: "Vega Foods", domain: "vega.com" },
      { name: "Vega Foods Inc", domain: "www.vega.com" },
    ]);
    assert.equal(fresh.length, 1);
  });

  describe("MSP-scoped checks", () => {
    const MSP_A = "00000000-0000-0000-0000-00000000000a";
    const MSP_B = "00000000-0000-0000-0000-00000000000b";
    const index = indexOf("customer", [
      { name: "Acme Dental", domain: "acmedental.com", current_msp_id: MSP_A },
    ]);

    test("a known client of THIS MSP is excluded", () => {
      const { known, fresh } = partitionCandidates(index, [{ name: "Acme Dental" }], {
        mspId: MSP_A,
      });
      assert.equal(fresh.length, 0);
      assert.equal(known.length, 1);
    });

    test("the same company under a DIFFERENT MSP is still a new find", () => {
      // The core scoping rule: Acme being MSP A's client says nothing about
      // whether it is also documented as MSP B's, which is real new information.
      const { known, fresh } = partitionCandidates(index, [{ name: "Acme Dental" }], {
        mspId: MSP_B,
      });
      assert.equal(known.length, 0);
      assert.equal(fresh.length, 1);
    });

    test("a domain hit does not override the MSP scope", () => {
      // Domain matching is decisive when unscoped, but under an MSP scope it
      // must still belong to that MSP or it would wrongly suppress research.
      const { fresh } = partitionCandidates(
        index,
        [{ name: "Acme Dental", domain: "acmedental.com" }],
        { mspId: MSP_B },
      );
      assert.equal(fresh.length, 1);
    });

    test("unscoped, we hold the company at all — so don't research it", () => {
      const { known } = partitionCandidates(index, [{ name: "Acme Dental" }]);
      assert.equal(known.length, 1);
    });
  });
});
