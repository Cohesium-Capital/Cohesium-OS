import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildExamples, permittedSource, wrap, type ExampleAnswers } from "./example-builder";
import { whatWentWrong } from "./example-smooth-guard";
import { completeProfile } from "../workspace/identity";

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
  },
});

const ANSWERS: ExampleAnswers = {
  recipients: "regional food manufacturers",
  curiosity: "where temp labour actually helps and where it just adds churn",
  operatorTopics: "how margins are holding up and where the good recruiters are going",
  region: "the Midwest",
};

describe("building examples from an interview", () => {
  test("the operator's own words appear in the example", () => {
    const { goldCustomer, goldMsp } = buildExamples(ANSWERS);
    assert.match(goldCustomer, /regional food manufacturers/);
    assert.match(goldCustomer, /where temp labour actually helps/);
    assert.match(goldMsp, /how margins are holding up/);
    assert.match(goldMsp, /in the Midwest/);
  });

  test("no trace of the market the skeleton came from", () => {
    const both = Object.values(buildExamples(ANSWERS)).join("\n");
    for (const leftover of ["pediatric", "mid-Atlantic", "managed IT", "MSP"]) {
      assert.ok(!both.includes(leftover), `"${leftover}" leaked in from the original market`);
    }
  });

  test("tokens survive so vocabulary still substitutes", () => {
    const { goldCustomer, goldMsp } = buildExamples(ANSWERS);
    for (const token of ["{{senderIntro}}", "{{senderName}}", "{{providerGeneric}}"]) {
      assert.ok(goldCustomer.includes(token), `${token} missing from the customer example`);
    }
    assert.ok(goldMsp.includes("{{providerPlural}}"));
    assert.ok(goldMsp.includes("{{market}}"));
  });

  test("blank answers fall back to the neutral phrasing rather than a gap", () => {
    const { goldCustomer } = buildExamples({ recipients: "", curiosity: "" });
    assert.match(goldCustomer, /companies like yours/);
    assert.ok(!goldCustomer.includes("  ,"), "no empty slot left behind");
    assert.ok(!/\s,/.test(goldCustomer), "no dangling punctuation from an empty answer");
  });

  test("the structure the drafting prompt depends on is intact", () => {
    const { goldCustomer } = buildExamples(ANSWERS);
    for (const marker of ["Email —", "LinkedIn —", "Subject:", "Thanks,"]) {
      assert.ok(goldCustomer.includes(marker), `missing ${marker}`);
    }
  });

  test("wrapping keeps lines readable", () => {
    const long = wrap("word ".repeat(60).trim());
    assert.ok(
      long.split("\n").every((l) => l.length <= 78),
      "no line should exceed the width the surrounding prompt uses",
    );
  });
});

describe("guarding the smoothing pass", () => {
  const original = buildExamples(ANSWERS).goldCustomer;
  const permitted = `${permittedSource(ANSWERS, STAFFING)}`;

  test("a genuine tightening is accepted", () => {
    // Same substance, fewer words — which is all the model is asked to do.
    const tightened = original.replace(
      "and figured someone in your seat would have a clear read on it",
      "and figured you would have a clear read on it",
    );
    assert.equal(whatWentWrong(original, tightened, permitted), null);
  });

  test("a rewrite that invents a specific is rejected", () => {
    const smuggled = original.replace(
      "regional food manufacturers",
      "regional food manufacturers across Wisconsin and Minnesota dairy country",
    );
    const problem = whatWentWrong(original, smuggled, permitted);
    assert.ok(problem, "invented geography must not pass");
    assert.match(problem!, /introduced specifics of its own/);
    assert.match(problem!, /Wisconsin/, "and it names what it caught");
  });

  test("invented material with no proper noun is still caught", () => {
    // The subtler failure: a fluent lowercase clause the operator never said.
    // No place, no name, nothing capitalised — so the specifics check is blind
    // to it and the volume backstop has to do the work.
    const padded = original.replace(
      "and figured someone in your seat would have a clear read on it",
      "and figured someone in your seat would have a clear read on it, especially given " +
        "how brutal seasonal turnover has become lately across smaller plants juggling " +
        "unpredictable overtime demands",
    );
    assert.match(whatWentWrong(original, padded, permitted)!, /added material/);
  });

  test("a rewrite that drops a token is rejected", () => {
    const broken = original.replace("{{senderIntro}}", "I'm a partner at a search fund");
    assert.match(whatWentWrong(original, broken, permitted)!, /altered the \{\{tokens\}\}/);
  });

  test("a rewrite that destroys the structure is rejected", () => {
    const flattened = original.replace("LinkedIn —", "").replace("Email —", "");
    assert.match(whatWentWrong(original, flattened, permitted)!, /dropped the/);
  });

  test("a rewrite that guts the example is rejected", () => {
    assert.match(whatWentWrong(original, "Email — Subject: hi", permitted)!, /cut the example/);
  });
});
