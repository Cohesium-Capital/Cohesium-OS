"use server";

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { importPayload } from "./import-core";
import type { ImportKind, ImportReport } from "./types";

// Server action: import as the signed-in user (RLS applies). All logic lives in
// importPayload so the same engine can run headlessly (CLI / automated sourcing).
export async function importSourced(input: {
  rawText: string;
  kind: ImportKind;
  targetMspId?: string | null;
}): Promise<ImportReport> {
  const user = await requireUser();
  const supabase = await createClient();
  return importPayload(supabase, { ...input, createdBy: user.id });
}
