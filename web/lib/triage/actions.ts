"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

// Triage actions for the keyboard reply queue. A triager reads each reply
// verbatim and marks a disposition; opt-outs write a suppression in the same
// action so no send path can race the human's verdict. Pending suppressions
// (the auto-matcher's guesses) are confirmed or revoked here too.

export type Disposition =
  | "positive"
  | "neutral"
  | "not_now"
  | "opt_out"
  | "ooo_auto"
  | "wrong_person";

export async function setDisposition(input: {
  interactionId: string;
  disposition: Disposition;
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();
  const actor = user.email ?? user.id;

  const { data: interaction, error } = await supabase
    .from("interactions")
    .update({
      disposition: input.disposition,
      triaged_by: actor,
      triaged_at: new Date().toISOString(),
    })
    .eq("id", input.interactionId)
    .select("contact_id")
    .single();
  if (error) throw new Error(error.message);

  // An opt-out disposition IS the do-not-contact signal: record the active
  // suppression atomically with the verdict, not as a separate later step.
  if (input.disposition === "opt_out") {
    const { error: supError } = await supabase.from("suppressions").insert({
      contact_id: interaction.contact_id,
      reason: "opt_out",
      status: "active",
      source: `triage:${input.interactionId}`,
      created_by: actor,
    });
    if (supError) throw new Error(supError.message);
  }

  revalidatePath("/triage");
  revalidatePath("/");
}

export async function resolveSuppression(input: {
  suppressionId: string;
  decision: "confirm" | "revoke";
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();
  const actor = user.email ?? user.id;

  // Only pending rows are resolvable — never flip an already-decided row, and
  // record who decided in the note (created_by stays the original creator).
  const verdict = input.decision === "confirm" ? "confirmed" : "revoked";
  const { data, error } = await supabase
    .from("suppressions")
    .update({
      status: input.decision === "confirm" ? "active" : "revoked",
      note: `${verdict} by ${actor} at ${new Date().toISOString()}`,
    })
    .eq("id", input.suppressionId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Suppression was already resolved.");

  revalidatePath("/triage");
  revalidatePath("/");
}

export type ContactHit = {
  id: string;
  full_name: string | null;
  org_name: string;
};

/** Contact lookup for the Log-interaction dialog: name or company, ilike. */
export async function searchContacts(query: string): Promise<ContactHit[]> {
  await requireUser();
  const term = query.trim();
  if (term.length < 2) return [];
  const supabase = await createClient();
  const pattern = `%${term}%`;

  // Two queries because PostgREST can't OR across the org join; merged by id.
  const [byName, byOrg] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, full_name, organizations(name)")
      .ilike("full_name", pattern)
      .is("deleted_at", null)
      .limit(8),
    supabase
      .from("contacts")
      .select("id, full_name, organizations!inner(name)")
      .ilike("organizations.name", pattern)
      .is("deleted_at", null)
      .limit(8),
  ]);
  if (byName.error) throw new Error(byName.error.message);
  if (byOrg.error) throw new Error(byOrg.error.message);

  type Row = { id: string; full_name: string | null; organizations: { name: string } | null };
  const seen = new Map<string, ContactHit>();
  for (const r of [...(byName.data ?? []), ...(byOrg.data ?? [])] as unknown as Row[]) {
    if (!seen.has(r.id)) {
      seen.set(r.id, {
        id: r.id,
        full_name: r.full_name,
        org_name: r.organizations?.name ?? "—",
      });
    }
  }
  return [...seen.values()].slice(0, 8);
}

export async function logInteraction(input: {
  contactId: string;
  channel: "email" | "linkedin" | "call" | "other";
  rawContent: string;
}): Promise<void> {
  await requireUser();
  const content = input.rawContent.trim();
  if (!content) throw new Error("Paste the conversation content first.");
  const supabase = await createClient();

  // disposition stays null so the logged conversation enters the triage queue
  // like any captured reply.
  const { error } = await supabase.from("interactions").insert({
    contact_id: input.contactId,
    channel: input.channel,
    occurred_at: new Date().toISOString(),
    raw_content: content,
    source: "manual",
  });
  if (error) throw new Error(error.message);

  revalidatePath("/triage");
  revalidatePath("/");
}
