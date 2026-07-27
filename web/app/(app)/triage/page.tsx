import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
import {
  TriageQueue,
  type TriageInteraction,
  type PendingSuppression,
} from "./triage-queue";

// Keyboard-driven reply triage. Every captured interaction without a
// disposition queues here oldest-first — each is a human answering us, and the
// verbatim text is the permanent ground truth behind every verdict. Pending
// suppressions (the conservative auto-matcher's guesses) surface alongside
// because they block sends until a human confirms or revokes them.

type InteractionRow = {
  id: string;
  contact_id: string;
  channel: string;
  occurred_at: string;
  raw_content: string;
  source: string | null;
  contacts: {
    full_name: string | null;
    title: string | null;
    email: string | null;
    organizations: { name: string } | null;
  } | null;
  touches: { subject: string | null; channel: string } | null;
};

type SuppressionRow = {
  id: string;
  reason: string;
  source: string | null;
  note: string | null;
  created_at: string;
  contacts: {
    full_name: string | null;
    organizations: { name: string } | null;
  } | null;
};

export default async function TriagePage() {
  const supabase = await createClient();
  // The workspace on screen — RLS alone would blend every workspace this user
  // belongs to into one triage queue. Suppressions carry no workspace_id
  // (child table), so they scope through the joined contact.
  const workspaceId = await currentWorkspaceId();

  const [{ data: interactionData }, { data: suppressionData }] = await Promise.all([
    supabase
      .from("interactions")
      .select(
        "id, contact_id, channel, occurred_at, raw_content, source, contacts!inner(full_name, title, email, organizations(name)), touches(subject, channel)",
      )
      .eq("workspace_id", workspaceId)
      .is("disposition", null)
      .is("contacts.deleted_at", null)
      .order("occurred_at", { ascending: true }),
    supabase
      .from("suppressions")
      .select(
        "id, reason, source, note, created_at, contacts!inner(full_name, workspace_id, organizations(name))",
      )
      .eq("status", "pending")
      .eq("contacts.workspace_id", workspaceId)
      .is("contacts.deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const interactions: TriageInteraction[] = (
    (interactionData ?? []) as unknown as InteractionRow[]
  ).map((r) => ({
    id: r.id,
    contact_id: r.contact_id,
    channel: r.channel,
    occurred_at: r.occurred_at,
    raw_content: r.raw_content,
    source: r.source,
    contact_name: r.contacts?.full_name ?? null,
    contact_title: r.contacts?.title ?? null,
    contact_email: r.contacts?.email ?? null,
    org_name: r.contacts?.organizations?.name ?? "—",
    replied_to_subject: r.touches?.subject ?? null,
  }));

  const suppressions: PendingSuppression[] = (
    (suppressionData ?? []) as unknown as SuppressionRow[]
  ).map((s) => ({
    id: s.id,
    reason: s.reason,
    source: s.source,
    note: s.note,
    created_at: s.created_at,
    contact_name: s.contacts?.full_name ?? "—",
    org_name: s.contacts?.organizations?.name ?? "—",
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Triage</h1>
        <p className="text-sm text-muted-foreground">
          {interactions.length} repl{interactions.length === 1 ? "y" : "ies"} awaiting a
          disposition
          {suppressions.length > 0 &&
            ` · ${suppressions.length} suppression${suppressions.length === 1 ? "" : "s"} to confirm`}
          . One keystroke each — opt-outs suppress the contact immediately.
        </p>
      </div>
      <TriageQueue interactions={interactions} suppressions={suppressions} />
    </div>
  );
}
