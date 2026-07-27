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

async function readRemote(token) {
  // Deliberately the API and not raw.githubusercontent.com: raw is served
  // through a CDN that lags a write by minutes, so verifying against it reports
  // drift that has already been fixed — a spurious CI failure, and worse, one
  // that trains you to ignore this check. The API is far fresher, though not
  // instant either: a read within ~10s of a write can still return the old
  // body. That is fine here because CI runs minutes after a merge, but it does
  // mean a dispatch fired immediately after a push can see stale content.
  const url = `https://api.github.com/repos/${REPO}/contents/${PATH_IN_REPO}?ref=${BRANCH}`;
  return fetch(url, {
    headers: {
      // Returns the file body itself rather than base64-in-JSON.
      accept: "application/vnd.github.raw",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function currentRemote(token) {
  // The repo is public, so this read needs no credential at all; a token buys
  // only a higher rate limit. That makes an invalid one strictly worse than
  // none — it turns a working anonymous read into a 401 — so a rejected
  // credential falls back to anonymous rather than failing the run. The write
  // path below is where a bad token must be reported, because there it matters.
  let res = await readRemote(token);
  if (token && (res.status === 401 || res.status === 403)) {
    res = await readRemote(null);
  }
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub API rate limit reached while verifying — retry in a few minutes");
  }
  if (!res.ok) throw new Error(`could not read the public copy: HTTP ${res.status}`);
  return res.text();
}

// 401 and 403/404 fail for different reasons and need different fixes, and the
// distinction is easy to get backwards: 401 is the credential being rejected
// outright, NOT a missing permission. Saying "does it have contents:write?" for
// a 401 sends you to check the one thing that isn't wrong.
function tokenError(status) {
  if (status === 401) {
    return new Error(
      `RUNNER_REPO_TOKEN was rejected by GitHub (401 — bad credentials). The token value ` +
        `itself is not recognised, so this is not a permissions problem. Check that it has not ` +
        `expired or been revoked, and that the whole value was copied. If it is a fine-grained ` +
        `PAT on an org-owned repo, confirm the organisation approved it.`,
    );
  }
  return new Error(
    `RUNNER_REPO_TOKEN was accepted but cannot write to ${REPO} (HTTP ${status}). Give it ` +
      `Contents: Read and write, with repository access including ${REPO}.`,
  );
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
  else if (head.status !== 404) throw tokenError(head.status);

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
    if (res.status === 401 || res.status === 403 || res.status === 404) throw tokenError(res.status);
    throw new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

// GITHUB_TOKEN only — it is always valid inside Actions and can read a public
// repo. Deliberately NOT the write token: reads do not need it, and reaching for
// it is what turned a bad credential into a failed verification.
const readToken = process.env.GITHUB_TOKEN?.trim() || null;
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
