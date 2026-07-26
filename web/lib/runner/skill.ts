import skill from "./skill.json";

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
