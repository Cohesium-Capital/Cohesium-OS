"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { createRun, ingestRun, type CreatedRun } from "./lifecycle";
import type { IngestOutcome, ModuleKey } from "@/lib/modules/types";

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
  return outcome;
}
