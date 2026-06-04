/**
 * Headless importer. Runs the same engine as the web app with a service-role
 * client (bypasses RLS — for trusted local/worker use only). This is the insert
 * path for automated sourcing: a fan-out produces a JSON payload, this writes it.
 *
 * Usage (env from the repo-root .env):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/import.ts <payload.json> <msp|customer> [targetMspId]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { importPayload } from "../lib/sourcing/import-core";
import type { ImportKind } from "../lib/sourcing/types";

async function main() {
  const [, , file, kind, target] = process.argv;
  if (!file || (kind !== "msp" && kind !== "customer")) {
    console.error("usage: tsx scripts/import.ts <payload.json> <msp|customer> [targetMspId]");
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const rawText = readFileSync(file, "utf8");
  const report = await importPayload(supabase, {
    rawText,
    kind: kind as ImportKind,
    targetMspId: target || null,
    createdBy: null,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main();
