import { createClient } from "@/lib/supabase/server";
import type { FailedRow } from "@/lib/drafting/types";
import { DraftQueue, type QueueRowWithHook } from "./draft-queue";

type Touch = {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  approved: boolean;
  status: string;
  last_error: string | null;
  contacts: { full_name: string | null; organization_id: string } | null;
  hooks: {
    text: string | null;
    source_url: string | null;
    kind: string;
    fallback_angle: string | null;
  } | null;
};

export default async function QueuePage() {
  const supabase = await createClient();

  // Soft-deleted contacts are excluded here because sendApproved excludes them
  // too — a draft the send path will never pick up must not sit in the queue
  // looking sendable.
  // The joined hook is what the drafter opened with — surfaced per row so the
  // reviewer can eyeball the claim against its source before approving (the
  // 100% backstop behind the sampled personalization gate).
  const { data } = await supabase
    .from("touches")
    .select(
      "id, channel, subject, body, approved, status, last_error, contacts!inner(full_name, organization_id), hooks(text, source_url, kind, fallback_angle)",
    )
    .in("status", ["planned", "failed"])
    .eq("direction", "outbound")
    .is("deleted_at", null)
    .is("contacts.deleted_at", null)
    .order("created_at", { ascending: false });

  const touches = (data ?? []) as unknown as Touch[];

  const orgIds = [
    ...new Set(touches.map((t) => t.contacts?.organization_id).filter(Boolean)),
  ] as string[];
  const orgInfo = new Map<string, { name: string; kind: string | null }>();
  if (orgIds.length) {
    const { data: orgs } = await supabase
      .from("organizations")
      .select("id, name, kind")
      .in("id", orgIds);
    orgs?.forEach((o) => orgInfo.set(o.id, { name: o.name, kind: o.kind ?? null }));
  }

  const rows: QueueRowWithHook[] = [];
  const failedRows: FailedRow[] = [];
  for (const t of touches) {
    const org = t.contacts?.organization_id
      ? orgInfo.get(t.contacts.organization_id)
      : undefined;
    if (t.status === "failed") {
      failedRows.push({
        id: t.id,
        channel: t.channel,
        subject: t.subject,
        contact_name: t.contacts?.full_name ?? null,
        company: org?.name ?? "—",
        last_error: t.last_error,
      });
    } else {
      rows.push({
        id: t.id,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        approved: t.approved,
        contact_name: t.contacts?.full_name ?? null,
        company: org?.name ?? "—",
        org_kind: org?.kind ?? null,
        hook: t.hooks
          ? {
              text: t.hooks.text,
              source_url: t.hooks.source_url,
              kind: t.hooks.kind,
              fallback_angle: t.hooks.fallback_angle,
            }
          : null,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Draft queue</h1>
        <p className="text-sm text-muted-foreground">
          Drafts arrive unapproved and send only after you explicitly approve them — read
          each message, glance at its hook against the source link, then check Send (or
          Approve all). To redo a batch, select rows and
          Send back to drafting — the drafts are retired (kept in history) and those
          contacts reappear on the Draft page to regenerate.
        </p>
      </div>
      <DraftQueue initialRows={rows} failedRows={failedRows} />
    </div>
  );
}
