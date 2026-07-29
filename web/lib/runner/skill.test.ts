import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_SKILL, renderRunnerSkill, runnerEnvTemplate } from "./skill";
import { DEFAULT_VOCAB } from "../workspace/identity";

// skill.json is a build artefact of the canonical SKILL.md, and the app hands it
// to collaborators as their copy of the skill. If the two drift, the app ships
// stale instructions to someone who has no other way to notice — so drift is a
// test failure, not a lint warning.

const CANONICAL = join(__dirname, "..", "..", "..", ".claude", "skills", "source-companies", "SKILL.md");

describe("runner skill bundle", () => {
  test("matches the canonical SKILL.md byte for byte", () => {
    if (!existsSync(CANONICAL)) {
      // Deployed builds don't ship the repo; only the checkout can compare.
      assert.ok(RUNNER_SKILL.content.length > 0);
      return;
    }
    assert.equal(
      RUNNER_SKILL.content,
      readFileSync(CANONICAL, "utf8"),
      "web/lib/runner/skill.json is stale — regenerate with `npm run sync:skill`",
    );
  });

  test("carries the frontmatter Claude Code needs to discover it", () => {
    // Without `name`/`description` in frontmatter the file is inert — it would
    // download fine and simply never trigger.
    assert.match(RUNNER_SKILL.content, /^---\n/);
    assert.match(RUNNER_SKILL.content, /\nname: source-companies\n/);
    assert.match(RUNNER_SKILL.content, /\ndescription: .+/);
  });

  test("installs to the personal skills path, so it works outside a repo", () => {
    assert.equal(RUNNER_SKILL.installPath, "~/.claude/skills/source-companies/SKILL.md");
    assert.equal(RUNNER_SKILL.filename, "SKILL.md");
  });

  test("renders the tenant's target-universe vocabulary, API literals fixed", () => {
    // Default vocab is Cohesium's, so the rendered skill reads "MSPs" and has no
    // unrendered tokens left.
    const cohesium = renderRunnerSkill(DEFAULT_VOCAB).content;
    assert.ok(!cohesium.includes("{{"), "no unrendered tokens for the default vocab");
    assert.match(cohesium, /find MSPs themselves/);

    // A TPA workspace sees its own term and no trace of "MSP" in the prose.
    const tpa = renderRunnerSkill({
      ...DEFAULT_VOCAB,
      providerAbbrev: "TPA",
      providerAbbrevPlural: "TPAs",
      providerGeneric: "TPA",
    }).content;
    assert.match(tpa, /find TPAs themselves/);
    assert.ok(!/\bMSPs?\b/.test(tpa), "a TPA workspace sees no MSP wording in the prose");

    // The API contract never moves, whatever the vocabulary.
    assert.match(tpa, /"mode":"research_customers"/);
    assert.match(tpa, /research_msps/);
    assert.match(tpa, /mspIds/);
  });

  test("the env template prefills the deployment origin and never a real token", () => {
    const env = runnerEnvTemplate("https://example.test");
    assert.match(env, /^COHESIUM_API_URL=https:\/\/example\.test$/m);
    assert.match(env, /^COHESIUM_API_TOKEN=paste-your-token-here$/m);
    assert.ok(!/cin_[0-9a-f]{8}/.test(env), "template must not contain a real token");
  });
});
