import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { DraftContact } from "@/lib/drafting/prompt";
import { Button } from "@/components/ui/button";
import { DraftBuilder } from "./draft-builder";

type Row = {
  id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  city: string | null;
  email: string | null;
  linkedin_url: string | null;
  batch_id: string | null;
  organizations: {
    name: string;
    domain: string | null;
    kind: string | null;
    current_msp_id: string | null;
  } | null;
  batches: { gate_status: string } | null;
};

// Contacts with at least one address (email or LinkedIn) are draftable. Channels
// are derived from which addresses exist.
export default async function DraftPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, city, email, linkedin_url, batch_id, organizations(name, domain, kind, current_msp_id), batches(gate_status)",
    )
    .is("deleted_at", null)
    .or("email.not.is.null,linkedin_url.not.is.null");

  // Suppression guard: a contact with any live suppression (active, or an
  // unconfirmed 'pending' auto-match) must never be sent to — so never drafted.
  const { data: suppressions } = await supabase
    .from("suppressions")
    .select("contact_id")
    .in("status", ["active", "pending"]);
  const suppressed = new Set((suppressions ?? []).map((s) => s.contact_id));

  // Gate guard: a contact can be drafted only once its batch has passed the eval
  // gate. Legacy direct-import contacts sit in a batch seeded 'passed', so they
  // remain draftable; new-run contacts wait until their batch clears grading.
  const all = ((data ?? []) as unknown as Row[]).filter(
    (r) =>
      (!r.batch_id || r.batches?.gate_status === "passed") && !suppressed.has(r.id),
  );

  // A contact is draftable only while they have NO live (non-deleted) planned
  // outbound touch — any draft in the send queue, approved or not, claims the
  // contact. "Send back to drafting" in the queue soft-deletes the draft
  // (delete_reason 'redraft'), which is what returns the contact here;
  // unapproving alone is just an approval toggle and keeps the contact queued.
  const { data: drafted } = await supabase
    .from("touches")
    .select("contact_id")
    .eq("status", "planned")
    .eq("direction", "outbound")
    .is("deleted_at", null);
  const hasPlanned = new Set((drafted ?? []).map((t) => t.contact_id));
  const rows = all.filter((r) => !hasPlanned.has(r.id));

  const mspIds = [
    ...new Set(rows.map((r) => r.organizations?.current_msp_id).filter(Boolean)),
  ] as string[];
  const mspName = new Map<string, string>();
  if (mspIds.length) {
    const { data: m } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", mspIds);
    m?.forEach((x) => mspName.set(x.id, x.name));
  }

  const contacts: DraftContact[] = rows
    .map((r) => ({
      contact_id: r.id,
      full_name: r.full_name,
      persona: r.persona,
      title: r.title,
      company_name: r.organizations?.name ?? "their company",
      company_domain: r.organizations?.domain ?? null,
      city: r.city,
      current_msp: r.organizations?.current_msp_id
        ? mspName.get(r.organizations.current_msp_id) ?? null
        : null,
      org_kind: r.organizations?.kind ?? null,
      channels: [
        ...(r.email ? (["email"] as const) : []),
        ...(r.linkedin_url ? (["linkedin"] as const) : []),
      ],
    }))
    .filter((c) => c.channels.length > 0);

  // Nothing draftable: diagnose why and point at the stage that unblocks it,
  // instead of a dead-end "run enrichment first".
  if (contacts.length === 0) {
    const [{ count: totalContacts }, { count: pendingEnrichment }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .eq("enrichment_status", "pending"),
    ]);

    let reason: { text: string; href: string; cta: string };
    if ((totalContacts ?? 0) === 0) {
      reason = {
        text: "There are no contacts in the system yet. Drafting starts with a sourcing run.",
        href: "/source",
        cta: "Start a sourcing run (step 1)",
      };
    } else if (all.length > 0) {
      // Gate-passed contacts with addresses exist, but every one already has
      // a draft waiting in the send queue.
      reason = {
        text: "Every draftable contact already has a message in the send queue. Approve and send those, or use Send back to drafting there to regenerate them.",
        href: "/draft/queue",
        cta: "Open the send queue (step 5)",
      };
    } else if ((data ?? []).length > 0) {
      reason = {
        text: "Contacts with an address exist, but none of their batches has passed the eval gate yet. Grade the sampled contacts to unlock them.",
        href: "/review/grade",
        cta: "Grade the samples (step 3)",
      };
    } else if ((pendingEnrichment ?? 0) > 0) {
      reason = {
        text: `${pendingEnrichment} contact${(pendingEnrichment ?? 0) === 1 ? " is" : "s are"} still waiting on enrichment — no email or LinkedIn yet. On Review & Enrich, push pending rows to Clay (part B).`,
        href: "/review",
        cta: "Go to Review & Enrich (step 2)",
      };
    } else {
      reason = {
        text: "No contact has an email or LinkedIn address to write to. Check Clay results on Review & Enrich, or source more contacts.",
        href: "/review",
        cta: "Go to Review & Enrich (step 2)",
      };
    }

    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Draft</h1>
          <p className="text-sm text-muted-foreground">
            Generate per-persona messages, then queue them for review.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm font-medium">Nothing to draft yet</p>
          <p className="text-sm text-muted-foreground">{reason.text}</p>
          <Button nativeButton={false} render={<Link href={reason.href} />}>
            {reason.cta} →
          </Button>
        </div>
      </div>
    );
  }

  return <DraftBuilder contacts={contacts} />;
}
