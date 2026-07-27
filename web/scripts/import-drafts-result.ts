/**
 * Store a draft-messages workflow result. Reads the workflow output JSON
 * ({ result: { drafts: [{ contact_id, channel, subject, body }] } }) and writes
 * each as a planned touch via the same storeDrafts core the web app uses.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/import-drafts-result.ts <workflow-output.json>
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { activeDraftPromptVersion, storeDrafts } from "../lib/drafting/import-core";
import type { Draft } from "../lib/drafting/contracts";

async function main() {
  const [, , file] = process.argv;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!file || !url || !key) {
    console.error(
      "usage: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. tsx scripts/import-drafts-result.ts <file>",
    );
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const drafts = (raw?.result?.drafts ?? raw?.drafts ?? []) as Draft[];
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Service-role client: nothing scopes these reads, so group the drafts by
  // the workspace that owns each contact and store per workspace — the active
  // prompt version stamped as provenance is per workspace too (028).
  const ids = [...new Set(drafts.map((d) => d.contact_id))];
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id, workspace_id")
    .in("id", ids);
  if (error) {
    console.error(`Could not resolve contact workspaces: ${error.message}`);
    process.exit(1);
  }
  const wsByContact = new Map((contacts ?? []).map((c) => [c.id, c.workspace_id as string]));
  const byWorkspace = new Map<string, Draft[]>();
  for (const d of drafts) {
    const ws = wsByContact.get(d.contact_id);
    if (!ws) continue; // unknown contact — storeDrafts reports it as skipped
    byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), d]);
  }
  if (!byWorkspace.size && drafts.length) {
    console.error("None of the drafts' contact_ids exist.");
    process.exit(1);
  }

  let failed = false;
  for (const [workspaceId, group] of byWorkspace) {
    const promptVersionId = await activeDraftPromptVersion(supabase, workspaceId);
    const report = await storeDrafts(supabase, group, { promptVersionId }, {}, workspaceId);
    console.log(JSON.stringify({ workspaceId, ...report }, null, 2));
    if (!report.ok) failed = true;
  }
  if (failed) process.exit(1);
}

main();
