import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  personalizationModule,
  HOOK_CHUNK_SIZE,
  type PersonalizationConfig,
  type PersonalizationContact,
} from "./personalization";
import { completeProfile, DEFAULT_PROFILE } from "../workspace/identity";

// The fixtures pin the exact text of both modes. These pin the properties that
// have to hold whatever the text says.

const contacts = (n: number): PersonalizationContact[] =>
  Array.from({ length: n }, (_, i) => ({
    contact_id: `c-${i + 1}`,
    full_name: `Person ${i + 1}`,
    title: null,
    company_name: `Company ${i + 1}`,
    company_domain: null,
    current_msp: null,
  }));

const config = (over: Partial<PersonalizationConfig> = {}): PersonalizationConfig => ({
  contacts: contacts(3),
  profile: DEFAULT_PROFILE,
  ...over,
});

const render = (c: PersonalizationConfig) => personalizationModule.renderPrompt(null, c);

describe("hook research: fan-out mode", () => {
  test("agent mode prepends the hand-off to the SAME brief single mode uses", () => {
    // The reason for prepending rather than rewording: a subagent must follow
    // byte-identical rules to the pasted path, or the two executors quietly
    // produce different work under one prompt_version.
    const single = render(config());
    const agent = render(config({ mode: "agent" }));
    assert.ok(agent.endsWith(single), "the single-mode brief survives verbatim");
    assert.ok(agent.length > single.length);
    assert.ok(!single.includes("Task tool"), "single mode carries no orchestration");
  });

  test("it tells subagents to search, which drafting's fan-out forbids", () => {
    // Drafting's subagents are told NOT to search (personalization is already
    // done). Here searching IS the task, and this is the line that says so.
    assert.match(render(config({ mode: "agent" })), /every subagent must use web search/i);
  });

  test("the chunk count follows the contact count and the chunk size", () => {
    const twenty = { contacts: contacts(20), profile: DEFAULT_PROFILE, mode: "agent" as const };
    assert.match(render({ ...twenty, chunkSize: 8 }), /into 3 chunk\(s\) of up to 8/);
    assert.match(render({ ...twenty, chunkSize: 20 }), /into 1 chunk\(s\) of up to 20/);
    // Default when the caller says nothing — lower than drafting's 15 because a
    // hook costs several searches and a verification.
    assert.equal(HOOK_CHUNK_SIZE, 8);
    assert.match(render(twenty), /of up to 8/);
  });

  test("it names the fan-out's own failure mode: a lost chunk", () => {
    assert.match(
      render(config({ mode: "agent" })),
      /exactly one row per contact_id/,
      "a dropped chunk is the failure a merge step invites",
    );
  });

  test("the hashed template does not move with the mode", () => {
    // Otherwise one brief would own two prompt_versions that ask for identical
    // work, and its error rate would be split across them by execution style.
    const single = personalizationModule.templateText!(config());
    const agent = personalizationModule.templateText!(config({ mode: "agent" }));
    assert.equal(single, agent);
  });

  test("a contact with no usable hook is still a completed contact", () => {
    // Fan-out multiplies the temptation to pad: a subagent that returns fewer
    // rows than it was given looks like it failed. Both modes have to keep
    // saying that an honest "none" is the right answer.
    for (const mode of ["single", "agent"] as const) {
      assert.match(render(config({ mode })), /honest "none"|honest "no hook"|kind "none"/i);
    }
  });
});

describe("hook research: tenant vocabulary", () => {
  test("the brief speaks the workspace's market, not the default one", () => {
    const tpa = completeProfile({
      vocab: {
        ...DEFAULT_PROFILE.vocab,
        providerAbbrev: "TPA",
        customerFunction: "HR or benefits",
        providerCasual: "TPA",
        market: "retirement TPA market",
        marketShort: "retirement TPA",
      },
    });
    const text = render(config({ profile: tpa, mode: "agent" }));
    assert.match(text, /they provide HR or benefits services/);
    assert.ok(!/\bIT\b/.test(text), "no default-market wording survives");
  });

  test("a config with no profile falls back to the default rather than crashing", () => {
    // Replaying an old run's stored config, from before the field existed.
    const text = render({ contacts: contacts(1) });
    assert.match(text, /they provide IT services/);
  });
});
