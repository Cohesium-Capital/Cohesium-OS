"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

// Approval is an explicit human act: record who approved and when. Unapproving
// clears both, so an unreviewed draft is never distinguishable from a reviewed
// one by accident.
function approvalPatch(approved: boolean, actor: string) {
  return approved
    ? { approved: true, approved_by: actor, approved_at: new Date().toISOString() }
    : { approved: false, approved_by: null, approved_at: null };
}

export async function setApproved(id: string, approved: boolean) {
  const user = await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("touches")
    .update(approvalPatch(approved, user.email ?? user.id))
    .eq("id", id)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}

// Bulk approval toggle. Unapproving is ONLY that — the draft stays in the send
// queue and its contact stays claimed. Returning a contact to the Draft page is
// redraftBulk (soft-delete), not unapproval.
export async function setApprovedBulk(ids: string[], approved: boolean) {
  if (!ids.length) return;
  const user = await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("touches")
    .update(approvalPatch(approved, user.email ?? user.id))
    .in("id", ids)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}

// "Send back to drafting": retire the draft by soft-deleting it with a
// 'redraft' reason. Draft-page eligibility is "no live planned touch", so
// removing the touch is what makes the contact draftable again. The rejected
// copy stays in the row (and touch_edits) as learning-loop material.
export async function redraftBulk(ids: string[]) {
  await deleteDraftsBulk(ids, "redraft");
}

// Retry failed sends: flip 'failed' back to 'queued' (clearing last_error) so
// the next email cron run picks them up again.
export async function retryFailedBulk(ids: string[]) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("touches")
    .update({ status: "queued", last_error: null })
    .in("id", ids)
    .eq("status", "failed")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/");
}

// Deletes are soft: the row (and its touch_edits history) stays for the
// learning loop; every read path filters deleted_at.
export async function deleteDraftsBulk(ids: string[], reason?: string) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("touches")
    .update({ deleted_at: new Date().toISOString(), delete_reason: reason ?? null })
    .in("id", ids)
    .is("deleted_at", null);
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
    .is("deleted_at", null)
    .maybeSingle();

  const { error } = await supabase
    .from("touches")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null);
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

export async function deleteDraft(id: string, reason?: string) {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("touches")
    .update({ deleted_at: new Date().toISOString(), delete_reason: reason ?? null })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/draft/queue");
  revalidatePath("/draft");
}
