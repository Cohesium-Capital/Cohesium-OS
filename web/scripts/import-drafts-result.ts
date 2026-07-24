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
import { storeDrafts } from "../lib/drafting/import-core";
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
  const report = await storeDrafts(supabase, drafts);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main();
