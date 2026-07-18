"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

export async function setApproved(id: string, approved: boolean) {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("touches").update({ approved }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}

// Bulk approve / "send back to drafting" (unapprove). Unapproving a draft makes
// its contact eligible again on the Draft page, so it can be regenerated without
// deleting the contact or the draft.
export async function setApprovedBulk(ids: string[], approved: boolean) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("touches").update({ approved }).in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}

export async function deleteDraftsBulk(ids: string[]) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("touches").delete().in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}

export async function updateDraft(
  id: string,
  patch: { subject?: string | null; body?: string },
) {
  const user = await requireUser();
  const supabase = await createClient();

  // Read the current copy first: a human edit is an implicit "the AI draft
  // wasn't good enough" signal, logged to touch_edits as eval-set material.
  const { data: before } = await supabase
    .from("touches")
    .select("subject, body")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase.from("touches").update(patch).eq("id", id);
  if (error) throw new Error(error.message);

  if (before) {
    const edits: { touch_id: string; field: string; previous_value: string | null; new_value: string | null; editor: string }[] = [];
    if (patch.subject !== undefined && patch.subject !== before.subject) {
      edits.push({
        touch_id: id,
        field: "subject",
        previous_value: before.subject,
        new_value: patch.subject,
        editor: user.email ?? user.id,
      });
    }
    if (patch.body !== undefined && patch.body !== before.body) {
      edits.push({
        touch_id: id,
        field: "body",
        previous_value: before.body,
        new_value: patch.body,
        editor: user.email ?? user.id,
      });
    }
    if (edits.length) {
      // Best-effort: an edit-log failure should never block the edit itself.
      const { error: logError } = await supabase.from("touch_edits").insert(edits);
      if (logError) console.error("touch_edits log failed:", logError.message);
    }
  }

  revalidatePath("/draft/queue");
}

export async function deleteDraft(id: string) {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("touches").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}
