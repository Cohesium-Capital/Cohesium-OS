"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

// Mutations for the review grid. Run as the signed-in user (RLS applies) and
// revalidate the page so the grid reflects the change.

export async function setReviewed(ids: string[], reviewed: boolean) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("contacts")
    .update({ reviewed })
    .in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/review");
}

export async function deleteContacts(ids: string[]) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("contacts").delete().in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/review");
}
