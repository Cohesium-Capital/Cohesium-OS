"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { createRun, ingestRun, type CreatedRun } from "./lifecycle";
import { learningTick } from "@/lib/learning/tick";
import { currentWorkspaceId } from "@/lib/workspace/context";
import type { IngestOutcome, ModuleKey } from "@/lib/modules/types";
import type { LearningModule } from "@/lib/learning/signals";

// Server actions wrapping the run lifecycle. Run as the signed-in user (RLS
// applies); the copy-paste executor is the default path.

export async function startRun(input: {
  module: ModuleKey;
  config: Record<string, unknown>;
  label: string;
}): Promise<CreatedRun> {
  const user = await requireUser();
  const supabase = await createClient();
  const created = await createRun(supabase, {
    module: input.module,
    config: input.config,
    label: input.label,
    createdBy: user.id,
    workspaceId: await currentWorkspaceId(),
  });
  revalidatePath("/runs");
  return created;
}

export async function submitRunOutput(input: {
  runId: string;
  rawText: string;
  requireEvidence?: boolean;
}): Promise<IngestOutcome & { batchId?: string | null }> {
  const user = await requireUser();
  const supabase = await createClient();
  const outcome = await ingestRun(supabase, {
    runId: input.runId,
    rawText: input.rawText,
    createdBy: user.id,
    requireEvidence: input.requireEvidence,
  });
  revalidatePath("/runs");
  revalidatePath("/review");

  // An ingest is the natural moment to learn: a batch just landed, which means
  // the corrections on the previous one have had time to accumulate. Guarded by
  // a signal floor and an hourly cooldown inside learningTick, and it never
  // throws — the ingest above has already succeeded either way.
  const { data: run } = await supabase
    .from("runs")
    .select("module, workspace_id")
    .eq("id", input.runId)
    .maybeSingle();
  if (run?.module && run?.workspace_id) {
    await learningTick(supabase, run.module as LearningModule, run.workspace_id as string);
  }

  return outcome;
}
