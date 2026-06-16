/**
 * P2 verification (self-cleaning): exercise the copy-paste run seam end-to-end
 * against the live DB without the UI.
 *   1. createRun(sourcing) → renders a prompt, opens a batch + run.
 *   2. ingestRun(pasted JSON) → evidence-bearing rows land in the batch (sampled,
 *      with evidence); the evidence-less row is logged to rejected_ingest.
 *   3. assert + clean up everything it created (rows are tagged P2VERIFY%).
 *
 * Usage:
 *   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. npx tsx scripts/verify-run-p2.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRun, ingestRun } from "../lib/runs/lifecycle";

const PREFIX = "P2VERIFY";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("usage: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. tsx scripts/verify-run-p2.ts");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } }) as unknown as SupabaseClient;

  // Pre-clean any leftovers from a prior run.
  await cleanup(supabase);

  // 1. createRun
  const { runId, batchId, prompt } = await createRun(supabase, {
    module: "sourcing",
    config: { mode: "research_customers", kind: "customer", region: "Virginia", count: 3 },
    label: `${PREFIX} batch`,
    createdBy: null,
  });
  console.log(`createRun → run=${runId} batch=${batchId}`);
  console.log(`prompt (first 120): ${prompt.slice(0, 120).replace(/\n/g, " ")}…`);

  // 2. ingestRun — two evidenced orgs, one evidence-less (must be rejected).
  const payload = {
    organizations: [
      {
        name: `${PREFIX} Acme Co`,
        domain: "p2verify-acme.com",
        hq_city: "Richmond",
        hq_state: "VA",
        current_msp_name: null,
        source_url: "https://example.com/acme-case-study",
        confidence: "high",
        contacts: [
          { full_name: "Jane Doe", persona: "owner", title: "CEO", linkedin_url: "https://linkedin.com/in/janedoe", source_url: "https://linkedin.com/in/janedoe", confidence: "high" },
        ],
      },
      {
        name: `${PREFIX} Beta LLC`,
        domain: "p2verify-beta.com",
        hq_city: "Norfolk",
        hq_state: "VA",
        current_msp_name: null,
        source_url: "https://example.com/beta-testimonial",
        confidence: "medium",
        contacts: [
          { full_name: "John Smith", persona: "head_of_it", title: "IT Director", linkedin_url: null, source_url: "https://example.com/beta-team", confidence: "medium" },
        ],
      },
      {
        // No source_url anywhere → must be rejected to rejected_ingest.
        name: `${PREFIX} Ghost Inc`,
        domain: "p2verify-ghost.com",
        hq_city: null,
        hq_state: null,
        current_msp_name: null,
        source_url: null,
        confidence: "low",
        contacts: [],
      },
    ],
  };

  const outcome = await ingestRun(supabase, { runId, rawText: JSON.stringify(payload) });
  console.log("ingest outcome:", JSON.stringify(outcome, null, 2));

  // 3. assertions
  const { count: contactsInBatch } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  const { count: rejected } = await supabase
    .from("rejected_ingest")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);
  const { data: runRow } = await supabase.from("runs").select("status").eq("id", runId).single();
  const { data: evContact } = await supabase
    .from("contacts")
    .select("full_name, evidence, sampled, review_status")
    .eq("batch_id", batchId)
    .limit(1)
    .maybeSingle();

  const checks: [string, boolean][] = [
    ["2 contacts in batch", contactsInBatch === 2],
    ["1 row rejected for missing evidence", rejected === 1],
    ["run status review_ready", runRow?.status === "review_ready"],
    ["inserted contact carries evidence", Array.isArray(evContact?.evidence) && evContact!.evidence.length > 0],
    ["inserted contact sampled + pending_review", evContact?.sampled === true && evContact?.review_status === "pending_review"],
  ];
  console.log("\n--- checks ---");
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }

  await cleanup(supabase);
  console.log(`\ncleanup done. ${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

async function cleanup(supabase: SupabaseClient) {
  // Orgs (contacts cascade), then test batches/runs/rejected rows.
  const { data: orgs } = await supabase.from("organizations").select("id").ilike("name", `${PREFIX}%`);
  if (orgs?.length) await supabase.from("organizations").delete().in("id", orgs.map((o) => o.id));
  const { data: batches } = await supabase.from("batches").select("id").ilike("label", `${PREFIX}%`);
  if (batches?.length) {
    const ids = batches.map((b) => b.id);
    const { data: runs } = await supabase.from("runs").select("id").in("batch_id", ids);
    if (runs?.length) {
      const runIds = runs.map((r) => r.id);
      await supabase.from("rejected_ingest").delete().in("run_id", runIds);
      await supabase.from("runs").delete().in("id", runIds);
    }
    await supabase.from("batches").delete().in("id", ids);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
