import { createClient } from "@/lib/supabase/server";
import type { QueueRow } from "@/lib/drafting/types";
import { DraftQueue } from "./draft-queue";

type Touch = {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  approved: boolean;
  contacts: { full_name: string | null; organization_id: string } | null;
};

export default async function QueuePage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("touches")
    .select("id, channel, subject, body, approved, contacts!inner(full_name, organization_id)")
    .eq("status", "planned")
    .eq("direction", "outbound")
    .order("created_at", { ascending: false });

  const touches = (data ?? []) as unknown as Touch[];

  const orgIds = [
    ...new Set(touches.map((t) => t.contacts?.organization_id).filter(Boolean)),
  ] as string[];
  const orgName = new Map<string, string>();
  if (orgIds.length) {
    const { data: orgs } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    orgs?.forEach((o) => orgName.set(o.id, o.name));
  }

  const rows: QueueRow[] = touches.map((t) => ({
    id: t.id,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    approved: t.approved,
    contact_name: t.contacts?.full_name ?? null,
    company: t.contacts?.organization_id
      ? orgName.get(t.contacts.organization_id) ?? "—"
      : "—",
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Draft queue</h1>
        <p className="text-sm text-muted-foreground">
          Approved messages send unless you uncheck them. To redo a batch, select rows and
          Send back to drafting — those contacts reappear on the Draft page to regenerate,
          with nothing deleted.
        </p>
      </div>
      <DraftQueue initialRows={rows} />
    </div>
  );
}
