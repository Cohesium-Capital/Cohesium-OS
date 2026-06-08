"use server";

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { DraftsPayloadSchema } from "./contracts";
import { storeDrafts } from "./import-core";
import { type DraftReport, EMPTY_DRAFT_REPORT } from "./types";

function fail(error: string): DraftReport {
  return { ...EMPTY_DRAFT_REPORT, ok: false, error };
}

// Server action: validate pasted drafts and store them as the signed-in user.
// All write logic lives in storeDrafts so the drafting workflow can store
// headlessly through the same path.
export async function importDrafts(rawText: string): Promise<DraftReport> {
  await requireUser();
  const supabase = await createClient();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail("That is not valid JSON. Paste the full JSON object the model returned.");
  }
  const result = DraftsPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return fail(`Validation failed — ${issues.join("; ")}`);
  }
  return storeDrafts(supabase, result.data.drafts);
}
