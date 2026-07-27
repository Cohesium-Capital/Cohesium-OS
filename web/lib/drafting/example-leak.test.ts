import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findExampleLeaks, distinctivePhrases, describeLeaks } from "./example-leak";
import { completeProfile, COHESIUM_COPY } from "../workspace/identity";

// The cases below are real. They come from Cohesium's own drafts, which is what
// makes them worth pinning: the "pediatric practices" ones are the exact shape
// that LOOKS like a leak and is not, and a detector that cannot tell the
// difference would cry wolf on a third of the queue.

const COHESIUM = completeProfile({ copy: COHESIUM_COPY });

describe("example leak detection", () => {
  test("a draft to a real pediatric practice is not a leak", () => {
    // Verbatim from a real draft. "pediatric practices" appears in both the
    // gold example and this draft — but the contact IS one, so the contact's
    // own record explains it.
    const draft =
      "Hi Trish,\n\nI've been digging into how busy pediatric practices actually get value " +
      "from a managed IT provider, where it truly helps versus where it just adds cost.";
    const context = "Oberlin Road Pediatrics, PA — pediatric practices — Raleigh — Practice Manager";
    assert.deepEqual(findExampleLeaks(draft, COHESIUM, context), []);
  });

  test("the same phrasing IS a leak when nothing about the contact explains it", () => {
    const draft =
      "Hi Dana,\n\nI've been digging into how growing pediatric practices actually work with " +
      "their managed IT providers, and figured someone in your seat would have a clear read.";
    const context = "Meridian Staffing — light industrial staffing agency — Ohio — Managing Partner";
    const leaks = findExampleLeaks(draft, COHESIUM, context);
    assert.ok(leaks.length > 0, "a staffing firm being written to about pediatric IT is a leak");
    assert.ok(
      leaks.some((l) => l.phrase.includes("pediatric practices")),
      `expected the borrowed market phrase, got ${JSON.stringify(leaks.map((l) => l.phrase))}`,
    );
  });

  test("imitating the voice without borrowing facts is clean", () => {
    // This is what the prompt actually asks for: same register and shape,
    // entirely the contact's own substance.
    const draft =
      "Hi Sam,\n\nWith Northlake opening a second warehouse this year, I've been trying to " +
      "understand what a good technology partner does during a build-out.\n\n" +
      "I'm a cofounder of Cohesium, an investment firm. Any chance you'd have a few minutes?";
    const context = "Northlake Logistics — second warehouse — Operations Director";
    assert.deepEqual(findExampleLeaks(draft, COHESIUM, context), []);
  });

  test("an empty draft finds nothing rather than throwing", () => {
    assert.deepEqual(findExampleLeaks("", COHESIUM, ""), []);
  });

  test("distinctive phrases skip runs that are pure filler", () => {
    // "and figured someone in your seat" is voice the prompt wants imitated;
    // a run of stopwords is not evidence of anything.
    const phrases = distinctivePhrases("the and for with that this have been was are");
    assert.deepEqual(phrases, [], "a run of filler yields no distinctive phrase");
  });

  test("the operator message names the phrases and never overwhelms", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      phrase: `phrase ${i}`,
      source: "gold" as const,
    }));
    const msg = describeLeaks(many)!;
    assert.match(msg, /7 draft phrase/);
    assert.match(msg, /\+4 more/, "shows a few and counts the rest");
    assert.equal(describeLeaks([]), null, "silence when there is nothing to say");
  });
});
