// Keep the public runner repo's copy of the skill in step with this one.
//
// The skill has three copies and only two of them were guarded. skill.test.ts
// pins web/lib/runner/skill.json to the canonical file, but the public repo —
// the one a collaborator actually selects in Claude Code — had nothing watching
// it. Its failure mode is the quiet kind: someone runs stale instructions for
// weeks and nothing anywhere says so.
//
// Two modes, chosen by whether a token is available:
//
//   token present  → publish. Pushes the canonical file to the public repo.
//   no token       → verify. Exits non-zero on drift with instructions.
//
// So CI is useful the moment it is added (verification needs no credential),
// and becomes fully automatic when RUNNER_REPO_TOKEN is set — no code change
// between the two.
//
// Usage:
//   node scripts/publish-skill.mjs            # publish if able, else verify
//   node scripts/publish-skill.mjs --verify   # verify only, never write

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "Cohesium-Capital/cohesium-runner";
const PATH_IN_REPO = ".claude/skills/source-companies/SKILL.md";
const BRANCH = "main";

const root = join(import.meta.dirname, "..", "..");
const canonicalPath = join(root, ".claude", "skills", "source-companies", "SKILL.md");
const verifyOnly = process.argv.includes("--verify");

const canonical = readFileSync(canonicalPath, "utf8");

// Prefer an explicit token (CI); fall back to the local gh session so the same
// command works from a laptop without exporting anything.
function resolveToken() {
  const fromEnv = process.env.RUNNER_REPO_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function currentRemote(token) {
  // Deliberately the API and not raw.githubusercontent.com: raw is served
  // through a CDN that lags a write by minutes, so verifying against it reports
  // drift that has already been fixed — a spurious CI failure, and worse, one
  // that trains you to ignore this check. The API reflects a push immediately.
  //
  // Reads of a public repo need no credential; a token is passed only when one
  // happens to be around, for the higher rate limit.
  const url = `https://api.github.com/repos/${REPO}/contents/${PATH_IN_REPO}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      // Returns the file body itself rather than base64-in-JSON.
      accept: "application/vnd.github.raw",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub API rate limit reached while verifying — retry, or set GH_TOKEN");
  }
  if (!res.ok) throw new Error(`could not read the public copy: HTTP ${res.status}`);
  return res.text();
}

async function push(token) {
  const api = `https://api.github.com/repos/${REPO}/contents/${PATH_IN_REPO}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };

  // The Contents API needs the blob sha to replace an existing file.
  let sha;
  const head = await fetch(`${api}?ref=${BRANCH}`, { headers });
  if (head.ok) sha = (await head.json()).sha;
  else if (head.status !== 404) {
    throw new Error(`could not read ${REPO}: HTTP ${head.status} — does the token have contents:write?`);
  }

  const res = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: "Sync sourcing runner skill from Cohesium-OS",
      content: Buffer.from(canonical, "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

// Read token is separate from the write token: verification only needs the
// higher rate limit, so any available credential will do, including none.
const readToken = process.env.GITHUB_TOKEN || process.env.RUNNER_REPO_TOKEN || process.env.GH_TOKEN || null;
const remote = await currentRemote(readToken);

if (remote === canonical) {
  console.log(`✓ ${REPO} is in step with the canonical skill`);
  process.exit(0);
}

const what = remote === null ? "missing from" : "out of date in";
const token = verifyOnly ? null : resolveToken();

if (!token) {
  console.error(
    [
      `✗ the runner skill is ${what} ${REPO}.`,
      "",
      "  A collaborator selecting that repo in Claude Code would get stale",
      "  instructions, with nothing to tell them so.",
      "",
      "  Fix locally:   npm run publish:skill      (uses your gh login)",
      "  Fix in CI:     add a RUNNER_REPO_TOKEN secret with contents:write",
      `                 on ${REPO}, and this step publishes on its own.`,
    ].join("\n"),
  );
  process.exit(1);
}

await push(token);
console.log(`✓ published the canonical skill to ${REPO}`);
