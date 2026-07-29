"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { importPayload } from "./import-core";
import type { ImportKind, ImportReport } from "./types";
import { currentWorkspaceId } from "@/lib/workspace/context";

// Server action: import as the signed-in user (RLS applies). Each import now
// opens a tracked batch + run so the records are visible in Runs and gradeable
// through the eval gate. sample_rate comes from settings (a ~20% sample by
// default). Evidence is not hard-required here — CSV MSP lists and low-confidence
// research rows still import (flagged); the strict evidence-required path is the
// explicit run seam (createRun/ingestRun). All record logic stays in
// importPayload so the same engine runs headlessly.
export async function importSourced(input: {
  rawText: string;
  kind: ImportKind;
  targetMspId?: string | null;
}): Promise<ImportReport> {
  const user = await requireUser();
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();

  const label = `${input.kind === "msp" ? "Target Companies" : "Customers"} import · ${new Date().toISOString().slice(0, 10)}`;

  // A failed batch or run insert is a failed import, not a degraded one:
  // contacts landing with batch_id null are treated as ALREADY GATED by
  // batchPassed(), so proceeding would let this import's rows skip the eval
  // gate entirely and flow straight to enrichment.
  const { data: batch, error: batchError } = await supabase
    .from("batches")
    .insert({ workspace_id: workspaceId, module: "sourcing", label })
    .select("id")
    .single();
  if (batchError || !batch) {
    throw new Error(`Could not open a batch for this import: ${batchError?.message ?? "no row"}`);
  }
  const batchId = batch.id as string;

  const { data: run, error: runError } = await supabase
    .from("runs")
    .insert({
      workspace_id: workspaceId,
      module: "sourcing",
      batch_id: batchId,
      executor: "copy_paste",
      provider_label: "copy-paste",
      config: { kind: input.kind, targetMspId: input.targetMspId ?? null },
      status: "ingesting",
    })
    .select("id")
    .single();
  if (runError || !run) {
    throw new Error(`Could not record a run for this import: ${runError?.message ?? "no row"}`);
  }
  const runId = run.id as string;

  const { data: s } = await supabase
    .from("settings")
    .select("sample_rate")
    .eq("workspace_id", workspaceId)
    .eq("module", "sourcing")
    .maybeSingle();
  const sampleRate = s?.sample_rate ?? 1;

  const report = await importPayload(supabase, {
    workspaceId,
    ...input,
    createdBy: user.id,
    batchId,
    runId,
    sampleRate,
    requireEvidence: false,
  });

  await supabase
    .from("runs")
    .update({ status: report.ok ? "review_ready" : "failed", error: report.ok ? null : report.error ?? null, finished_at: new Date().toISOString() })
    .eq("id", runId);

  revalidatePath("/runs");
  revalidatePath("/review");
  return report;
}
