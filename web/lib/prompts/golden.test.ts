import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allPromptVariants } from "./variants";

// Byte-for-byte guard on every prompt the system renders.
//
// The prompts ARE the product: a stray word change in the drafting rules moves
// what lands in a stranger's inbox, and a change to a sourcing template silently
// forks prompt_versions, which is what error rates are compared across. The
// fixtures in __fixtures__ were captured before per-workspace vocabulary existed,
// so this suite is what proves that making the text configurable did not change
// the text Cohesium actually sends.
//
// When a prompt SHOULD change, re-capture the fixtures in the same commit. A
// diff you can read is the point — an untracked prompt change is not reviewable.

const FIXTURES = join(__dirname, "__fixtures__");

describe("prompt golden fixtures", () => {
  const variants = allPromptVariants();

  test("every variant still renders exactly as captured", () => {
    const mismatches: string[] = [];
    for (const v of variants) {
      const expected = readFileSync(join(FIXTURES, `${v.name}.txt`), "utf8");
      if (v.text !== expected) mismatches.push(v.name);
    }
    assert.deepEqual(
      mismatches,
      [],
      `prompt text changed for: ${mismatches.join(", ")}. If intended, re-capture the fixtures.`,
    );
  });

  test("no fixture is orphaned and no variant is unfixtured", () => {
    // Catches the failure this suite would otherwise miss: deleting a variant
    // makes its assertions vanish silently rather than fail.
    const onDisk = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => f.replace(/\.txt$/, ""))
      .sort();
    assert.deepEqual(
      variants.map((v) => v.name).sort(),
      onDisk,
      "variant list and fixture directory have drifted apart",
    );
  });

  test("the fixtures are not accidentally empty", () => {
    // A builder that returns "" would otherwise pass the comparison above
    // against an equally empty fixture.
    for (const v of variants) {
      assert.ok(v.text.length > 200, `${v.name} rendered suspiciously short`);
    }
  });
});
