// Regenerate web/lib/runner/skill.json from the canonical skill file.
//   npm run sync:skill
//
// The app serves the skill to collaborators who have no repository access, so
// the copy it serves must track the real one. skill.test.ts enforces that; this
// is how you fix it when it fails.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const source = join(root, ".claude", "skills", "source-companies", "SKILL.md");
const target = join(root, "web", "lib", "runner", "skill.json");

const content = readFileSync(source, "utf8");
writeFileSync(
  target,
  JSON.stringify(
    {
      filename: "SKILL.md",
      installPath: "~/.claude/skills/source-companies/SKILL.md",
      content,
    },
    null,
    2,
  ) + "\n",
);

console.log(`synced ${content.length} chars → web/lib/runner/skill.json`);
