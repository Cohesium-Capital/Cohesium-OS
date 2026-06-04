/**
 * Import a source-customers workflow result. Reads the workflow's output JSON
 * (which has { result: { results: [{ mspId, mspName, payload }] } }) and imports
 * each MSP's payload as customers, attributed to that MSP so the run is logged.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/import-workflow-result.ts <workflow-output.json>
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { importPayload } from "../lib/sourcing/import-core";

async function main() {
  const [, , file] = process.argv;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!file || !url || !key) {
    console.error(
      "usage: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. tsx scripts/import-workflow-result.ts <file>",
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const results = raw?.result?.results ?? raw?.results ?? [];
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const r of results) {
    const report = await importPayload(supabase, {
      rawText: JSON.stringify(r.payload),
      kind: "customer",
      targetMspId: r.mspId ?? null,
      createdBy: null,
    });
    const newForMsp = report.ok ? report.inserted.organizations : 0;
    console.log(
      `${r.mspName}: ${report.ok ? "ok" : "FAILED"} — +${newForMsp} new, ` +
        `${report.merged} enriched, ${report.inserted.contacts} contact(s), ` +
        `${report.skippedDuplicates} dup(s)` +
        (report.error ? ` — ${report.error}` : ""),
    );
  }
}

main();
