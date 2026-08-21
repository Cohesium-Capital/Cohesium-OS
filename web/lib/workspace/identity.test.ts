import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { articleFor, completeProfile, renderCopy, DEFAULT_PROFILE } from "./identity";
import { buildDraftPrompt, buildTemplateText as draftTemplate } from "../drafting/prompt";
import { buildPrompt as sourcingPrompt } from "../sourcing/prompts";

// The golden fixtures prove the refactor changed nothing for Cohesium. These
// prove the other half — that it actually made the prompts configurable. Both
// halves are needed: a builder that ignored its profile argument entirely would
// pass the golden suite perfectly.

const STAFFING = completeProfile({
  firmName: "Meridian",
  senderName: "Dana",
  senderIntro: "I'm a partner at Meridian, a search fund",
  vocab: {
    providerSingular: "staffing agency",
    providerPlural: "staffing agencies",
    providerAbbrev: "agency",
    providerAbbrevPlural: "agencies",
    providerGeneric: "staffing partner",
    market: "light industrial staffing market",
    marketShort: "staffing",
    customerFunction: "hiring",
    providerCasual: "staffing partner",
    channelSingular: "recruiting consultant",
    channelPlural: "recruiting consultants",
    channelAbbrev: "consultant",
    channelAbbrevPlural: "consultants",
  },
});

describe("workspace profile", () => {
  test("an override replaces the default and leaves the rest alone", () => {
    const p = completeProfile({ firmName: "Meridian" });
    assert.equal(p.firmName, "Meridian");
    assert.equal(p.senderName, DEFAULT_PROFILE.senderName, "untouched fields keep defaults");
    assert.equal(p.vocab.providerAbbrev, "MSP");
  });

  test("a partial vocab override keeps the unspecified terms", () => {
    const p = completeProfile({ vocab: { providerAbbrev: "agency" } as never });
    assert.equal(p.vocab.providerAbbrev, "agency");
    assert.equal(p.vocab.market, DEFAULT_PROFILE.vocab.market);
  });

  test("null input is the default profile, not a crash", () => {
    assert.deepEqual(completeProfile(null), DEFAULT_PROFILE);
  });

  test("copy tokens resolve against the profile that renders them", () => {
    const out = renderCopy("{{senderName}} at {{firmName}} covers {{market}}", STAFFING);
    assert.equal(out, "Dana at Meridian covers light industrial staffing market");
  });

  test("an unknown token is left alone rather than blanked", () => {
    // Blanking would silently delete a sentence from a prompt; leaving the
    // token visible makes the mistake obvious in the preview.
    assert.equal(renderCopy("keep {{nope}} here", STAFFING), "keep {{nope}} here");
  });

  test("the drafting prompt actually carries the workspace's identity", () => {
    const text = draftTemplate("customer", "", STAFFING);
    assert.match(text, /Dana at Meridian/);
    assert.match(text, /staffing agency \(an agency\)/);
    assert.match(text, /light industrial staffing market/);
    assert.ok(!text.includes("Cohesium"), "no trace of the default firm");
    assert.ok(!/\bRipley\b/.test(text), "no trace of the default sender");
    assert.match(text, /"Meridian \+ <company>"/, "subject shapes carry the firm's own name");
  });

  test("a workspace that overrides nothing gets neutral examples, not another firm's market", () => {
    // This is the phase-2 limitation, now fixed. It used to assert the
    // opposite — that a new workspace inherited "growing pediatric practices" —
    // because the default examples were Cohesium's. They are neutral now, and
    // Cohesium's own text lives in its workspace_profile (migration 039).
    const text = draftTemplate("customer", "", STAFFING);
    assert.ok(!text.includes("pediatric"), "no borrowed market in the default examples");
    assert.ok(!text.includes("mid-Atlantic"), "no borrowed geography either");
    // Still a worked example, and still speaking this firm's language.
    assert.match(text, /Gold examples/);
    assert.match(text, /staffing partners/, "the example uses their vocabulary");
  });

  test("a workspace can still replace the examples wholesale", () => {
    const overridden = draftTemplate(
      "customer",
      "",
      completeProfile({
        ...STAFFING,
        copy: {
          ...STAFFING.copy,
          goldCustomer:
            "Gold examples\n\nEmail —\nSubject: your hiring pipeline\n\nHi Sam,\n\n{{senderIntro}}.",
        },
      }),
    );
    assert.match(overridden, /your hiring pipeline/);
    assert.match(overridden, /I'm a partner at Meridian, a search fund\./, "tokens still resolve");
  });

  test("the sourcing prompt actually carries the workspace's vocabulary", () => {
    const text = sourcingPrompt({
      mode: "research_msps",
      region: "Ohio",
      count: 10,
      workspace: STAFFING,
    });
    assert.match(text, /sourcing staffing agencies \(agencies\)/);
    assert.match(text, /real agencies based in Ohio/);
    assert.ok(!text.includes("MSP"), "no trace of the default vocabulary");
  });

  test("a draft rendered for another firm signs off as that firm's sender", () => {
    const text = buildDraftPrompt(
      [
        {
          contact_id: "c1",
          full_name: "Sam Ortiz",
          persona: "owner",
          title: null,
          company_name: "Ortiz Fabrication",
          company_domain: null,
          city: null,
          current_msp: null,
          org_kind: "customer",
          channels: ["email"],
        },
      ],
      "customer",
      "",
      STAFFING,
    );
    assert.match(text, /Sign emails as Dana/);
    assert.ok(!text.includes("Ripley"));
  });
});

describe("articleFor", () => {
  test("an initialism follows its first letter's NAME, not its spelling", () => {
    // The bug this exists for: the prompts hardcoded "an", correct for "an MSP"
    // (em) and wrong for every Ilium prompt, which read "an TPA" (tee).
    assert.equal(articleFor("MSP"), "an");
    assert.equal(articleFor("TPA"), "a");
    assert.equal(articleFor("HR"), "an");
    assert.equal(articleFor("CPA"), "a");
  });

  test("an ordinary word goes by its first letter", () => {
    assert.equal(articleFor("managed IT service provider"), "a");
    assert.equal(articleFor("third-party administrator"), "a");
    assert.equal(articleFor("agency"), "an");
    assert.equal(articleFor("insurance brokerage"), "an");
  });

  test("degrades to \"a\" rather than throwing on nothing", () => {
    assert.equal(articleFor(""), "a");
    assert.equal(articleFor("   "), "a");
  });
});

describe("customer-side vocabulary", () => {
  // customerFunction is the function a PROSPECT outsources, and providerCasual
  // is what that prospect calls the provider. Conflating either with the
  // provider terms is what put "the person who leads IT" in a retirement-plan
  // tenant's brief, so both tracks are pinned here.
  const TPA = completeProfile({
    vocab: {
      ...DEFAULT_PROFILE.vocab,
      providerSingular: "third-party administrator",
      providerPlural: "third-party administrators",
      providerAbbrev: "TPA",
      providerAbbrevPlural: "TPAs",
      providerGeneric: "TPA",
      providerCasual: "TPA",
      customerFunction: "HR or benefits",
      // Overridden so the no-IT assertions below mean what they say: leaving
      // these at the defaults ("managed IT market") makes "IT" appear for an
      // honest reason and the test fails on its own fixture.
      market: "retirement TPA market",
      marketShort: "retirement TPA",
    },
  });

  test("sourcing asks for the tenant's function, keeping the persona key", () => {
    const text = sourcingPrompt({ mode: "research_customers", region: "Chicago", workspace: TPA });
    assert.match(text, /the person who leads HR or benefits \("head_of_it"\)/);
    assert.ok(!/leads IT\b/.test(text), "no IT wording survives for a TPA workspace");
    // The persona key is a schema CHECK and a JSON contract literal: it moves for
    // nobody, whatever the market is called.
    assert.match(text, /"persona": "owner" \| "head_of_it" \| "other"/);
  });

  test("drafting frames the recipient by function and the provider casually", () => {
    const text = draftTemplate("customer", "", TPA);
    assert.match(text, /runs or leads HR or benefits at a company that uses a third-party administrator \(a TPA\)/);
    assert.match(text, /work with their TPA/);
    assert.ok(!/\bIT\b/.test(text), "no IT wording survives for a TPA workspace");
  });

  test("Cohesium's defaults still render the exact prior wording", () => {
    // The golden fixtures are the real guard; this states the intent in one place.
    const text = draftTemplate("customer", "", DEFAULT_PROFILE);
    assert.match(text, /runs or leads IT at a company that uses a managed IT service provider \(an MSP\)/);
    assert.match(text, /work with their IT provider/);
  });
});
