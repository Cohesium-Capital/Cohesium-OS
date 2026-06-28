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
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("touches").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
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
