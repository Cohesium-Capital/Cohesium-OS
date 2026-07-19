/**
 * Headless run: create a tracked run+batch and ingest a payload through the
 * real lifecycle (createRun -> ingestRun), so records land with batch tagging,
 * deterministic sampling for the Grade queue, and evidence-required rejection —
 * unlike import-workflow-result.ts, which bypasses the eval layer.
 *
 * Usage:
 *   cd web && set -a && source .env.local && set +a && \
 *     npx tsx scripts/run-ingest.ts --module sourcing --label "..." \
 *       --config config.json --payload payload.json
 *
 * config.json  : the run config (e.g. {"mode":"research_msps","kind":"msp",...})
 * payload.json : the model/agent output matching the module's contract
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createRun, ingestRun } from "../lib/runs/lifecycle";
import type { ModuleKey } from "../lib/modules/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (web/.env.local).");
    process.exit(1);
  }

  const module = arg("module") as ModuleKey | undefined;
  const label = arg("label");
  const configFile = arg("config");
  const payloadFile = arg("payload");
  if (!module || !label || !configFile || !payloadFile) {
    console.error(
      "usage: tsx scripts/run-ingest.ts --module <key> --label <text> --config <file.json> --payload <file.json>",
    );
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const rawText = readFileSync(payloadFile, "utf8");
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const run = await createRun(supabase, { module, config, label });
  console.log(`run ${run.runId}\nbatch ${run.batchId}\nprompt_version ${run.promptVersionId ?? "(none)"}`);

  const outcome = await ingestRun(supabase, { runId: run.runId, rawText });
  console.log(
    `${outcome.ok ? "OK" : "FAILED"} — inserted ${outcome.inserted}, rejected ${outcome.rejected}, sampled ${outcome.sampledCount}`,
  );
  for (const m of outcome.messages) console.log(`  ${m}`);
  if (outcome.error) console.error(`  error: ${outcome.error}`);
  process.exit(outcome.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
