"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { importPayload } from "./import-core";
import type { ImportKind, ImportReport } from "./types";

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

  const label = `${input.kind === "msp" ? "MSPs" : "Customers"} import · ${new Date().toISOString().slice(0, 10)}`;

  const { data: batch } = await supabase
    .from("batches")
    .insert({ module: "sourcing", label })
    .select("id")
    .single();
  const batchId = (batch?.id as string | null) ?? null;

  let runId: string | null = null;
  if (batchId) {
    const { data: run } = await supabase
      .from("runs")
      .insert({
        module: "sourcing",
        batch_id: batchId,
        executor: "copy_paste",
        provider_label: "copy-paste",
        config: { kind: input.kind, targetMspId: input.targetMspId ?? null },
        status: "ingesting",
      })
      .select("id")
      .single();
    runId = (run?.id as string | null) ?? null;
  }

  const { data: s } = await supabase
    .from("settings")
    .select("sample_rate")
    .eq("module", "sourcing")
    .maybeSingle();
  const sampleRate = s?.sample_rate ?? 1;

  const report = await importPayload(supabase, {
    ...input,
    createdBy: user.id,
    batchId,
    runId,
    sampleRate,
    requireEvidence: false,
  });

  if (runId) {
    await supabase
      .from("runs")
      .update({ status: report.ok ? "review_ready" : "failed", error: report.ok ? null : report.error ?? null, finished_at: new Date().toISOString() })
      .eq("id", runId);
  }

  revalidatePath("/runs");
  revalidatePath("/review");
  return report;
}
