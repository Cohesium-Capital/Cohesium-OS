import { createHash } from "node:crypto";

// Identity of a prompt template for mechanical versioning: the same instruction
// text always hashes the same, regardless of line-ending or edge-whitespace
// noise, so (module, template_hash) can key auto-registered prompt_versions.
export function templateHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
