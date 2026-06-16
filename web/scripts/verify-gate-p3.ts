/**
 * P3 verification (self-cleaning): the eval gate end-to-end.
 *   - Batch A: 20 sampled contacts, 18 approved + 2 corrected (10% error) → PASSED
 *   - Batch B: 20 sampled contacts, 15 approved + 5 corrected (25% error) → FAILED
 *   - corrected contacts produce grade rows → eval-set has correction pairs
 *
 * Usage:
 *   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. npx tsx scripts/verify-gate-p3.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { computeGate, finalizeContact, recordGrade } from "../lib/grading/gate";

const PREFIX = "P3VERIFY";

async function seedBatch(supabase: SupabaseClient, label: string, n: number) {
  const { data: batch } = await supabase
    .from("batches")
    .insert({ module: "sourcing", label: `${PREFIX} ${label}`, gate_status: "open" })
    .select("id")
    .single();
  const { data: org } = await supabase
    .from("organizations")
    .insert({ name: `${PREFIX} Org ${label}`, kind: "customer", confidence: "high" })
    .select("id")
    .single();
  const rows = Array.from({ length: n }, (_, i) => ({
    organization_id: org!.id,
    full_name: `${PREFIX} Person ${label}${i}`,
    persona: "owner",
    stage: "sourced",
    enrichment_status: "pending",
    batch_id: batch!.id,
    sampled: true,
    review_status: "pending_review",
    evidence: [{ url: "https://example.com/x", via: "sourcing" }],
  }));
  const { data: contacts } = await supabase.from("contacts").insert(rows).select("id");
  return { batchId: batch!.id as string, contactIds: (contacts ?? []).map((c) => c.id as string) };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("usage: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. tsx scripts/verify-gate-p3.ts");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } }) as unknown as SupabaseClient;
  await cleanup(supabase);

  // --- Batch A: 2/20 errors = 10% < 20% → passed ---
  const a = await seedBatch(supabase, "A", 20);
  for (let i = 0; i < a.contactIds.length; i++) {
    const id = a.contactIds[i];
    if (i < 2) {
      await recordGrade(supabase, {
        contactId: id, module: "sourcing", field: "name", verdict: "wrong",
        correction: "Fixed Name", previousValue: `${PREFIX} Person A${i}`, grader: "verify",
      });
      await finalizeContact(supabase, { contactId: id, status: "corrected", batchId: a.batchId });
    } else {
      await finalizeContact(supabase, { contactId: id, status: "approved", batchId: a.batchId });
    }
  }
  const ma = await computeGate(supabase, a.batchId);

  // --- Batch B: 5/20 errors = 25% ≥ 20% → failed ---
  const b = await seedBatch(supabase, "B", 20);
  for (let i = 0; i < b.contactIds.length; i++) {
    const id = b.contactIds[i];
    if (i < 5) await finalizeContact(supabase, { contactId: id, status: "corrected", batchId: b.batchId });
    else await finalizeContact(supabase, { contactId: id, status: "approved", batchId: b.batchId });
  }
  const mb = await computeGate(supabase, b.batchId);

  // --- eval-set rows from grades ---
  const { count: gradeRows } = await supabase
    .from("grades")
    .select("id", { count: "exact", head: true })
    .eq("verdict", "wrong");

  console.log("Batch A metrics:", JSON.stringify(ma));
  console.log("Batch B metrics:", JSON.stringify(mb));

  const checks: [string, boolean][] = [
    ["Batch A passes at 10% error", ma.status === "passed" && Math.abs(ma.errorRate - 0.1) < 0.001],
    ["Batch A graded 20/20", ma.gradedCount === 20 && ma.sampleSize === 20],
    ["Batch B fails at 25% error", mb.status === "failed"],
    ["eval-set has correction pairs", (gradeRows ?? 0) >= 2],
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
  const { data: orgs } = await supabase.from("organizations").select("id").ilike("name", `${PREFIX}%`);
  if (orgs?.length) await supabase.from("organizations").delete().in("id", orgs.map((o) => o.id)); // contacts + grades cascade
  const { data: batches } = await supabase.from("batches").select("id").ilike("label", `${PREFIX}%`);
  if (batches?.length) await supabase.from("batches").delete().in("id", batches.map((b) => b.id));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
