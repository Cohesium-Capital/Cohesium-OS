import skill from "./skill.json";
import neutralVocab from "./neutral-vocab.json";
import type { WorkspaceVocab } from "../workspace/identity";

// The sourcing-runner skill, served to operators from Settings so onboarding a
// collaborator needs no repository access at all — the app is the distribution
// point for its own tooling.
//
// Held as JSON rather than read from `.claude/skills/…` at request time: that
// path sits outside the Next app root, so it is not traced into the deployed
// bundle and an fs read would work locally and 404 in production. A JSON import
// is bundled at build time, so what the app serves is guaranteed to exist.
//
// skill.json is generated from the canonical `.claude/skills/source-companies/
// SKILL.md`, and skill.test.ts fails if the two drift — the copy is a build
// artefact, not a second source of truth. Regenerate with:
//   npm run sync:skill

export const RUNNER_SKILL: {
  filename: string;
  installPath: string;
  content: string;
} = skill;

/**
 * The skill rendered for one workspace's market. The canonical SKILL.md carries
 * {{provider…}} tokens so the runner's framing names the tenant's own target
 * universe — "MSPs" for Cohesium, "TPAs" for Ilium — while the API-contract
 * literals (mode keys, `mspIds`) stay fixed. The per-run research brief is still
 * the authority; this only aligns the surrounding instructions. Unknown tokens
 * are left intact rather than blanked, so a typo is visible, not silently empty.
 */
export function renderRunnerSkill(vocab: WorkspaceVocab): {
  filename: string;
  installPath: string;
  content: string;
} {
  const map = vocab as unknown as Record<string, string>;
  const content = RUNNER_SKILL.content.replace(
    /\{\{(\w+)\}\}/g,
    (m, key: string) => map[key] ?? m,
  );
  return { ...RUNNER_SKILL, content };
}

/**
 * Vocabulary for the copy published to the public runner repo.
 *
 * That copy is fetched by whoever selects the repo in Claude Code, so it belongs
 * to no tenant and cannot be rendered for one. The two obvious alternatives are
 * both wrong: publishing the canonical file leaves `{{providerAbbrevPlural}}`
 * showing in a document a collaborator is meant to read, and rendering it with
 * DEFAULT_VOCAB lends Cohesium's market ("MSPs") to every tenant — the thing
 * migration 039 and this token substitution exist to stop.
 *
 * So the public copy says "provider(s)": generic, accurate for any market, and
 * the words a reader would supply themselves. It costs nothing, because the
 * per-run brief that actually governs the research is rendered from the
 * workspace's own vocabulary server-side, and the skill's own text is procedure.
 *
 * `web/scripts/publish-skill.mjs` reads this same JSON — it cannot be run through
 * a TypeScript loader in CI, so it re-applies the one-line substitution rather
 * than importing `publicRunnerSkill`. The vocabulary therefore has one home, but
 * the substitution has two: change the regex in one and change it in both.
 */
export const NEUTRAL_VOCAB: WorkspaceVocab = neutralVocab;

/** Exactly what publish-skill.mjs pushes to the public repo. */
export const publicRunnerSkill = () => renderRunnerSkill(NEUTRAL_VOCAB);

/**
 * Public repository carrying only this skill.
 *
 * It exists because Claude Code asks for a repository when creating an
 * environment, and a collaborator should not need access to this one to run
 * sourcing. Selecting that repo brings the skill with it, which is why it is the
 * primary route — the file download only helps someone using the terminal, where
 * there is no picker to satisfy.
 *
 * Public and safe to be: no credentials, no application code, and the research
 * methodology lives in prompts.ts and only reaches an authenticated caller.
 */
export const RUNNER_REPO_URL = "https://github.com/Cohesium-Capital/cohesium-runner";

/** The .env a runner needs. `origin` prefills the deployment they're using. */
export function runnerEnvTemplate(origin: string): string {
  return [
    "# Cohesium sourcing runner — put this in the directory you run Claude Code from.",
    "# The token is a bearer credential: keep it out of version control.",
    `COHESIUM_API_URL=${origin}`,
    "COHESIUM_API_TOKEN=paste-your-token-here",
    "",
  ].join("\n");
}
