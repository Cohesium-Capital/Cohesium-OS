import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { draftEligibleContactIds } from "@/lib/journey";
import { usableHooksByContact } from "@/lib/hooks/usable";
import type { DraftContact } from "@/lib/drafting/prompt";
import { Button } from "@/components/ui/button";
import { DraftBuilder } from "./draft-builder";
import { loadRunScope } from "@/lib/runs/scope";
import { RunScopeBanner } from "@/components/run-scope-banner";
import { currentWorkspaceId } from "@/lib/workspace/context";

type Row = {
  id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  city: string | null;
  email: string | null;
  linkedin_url: string | null;
  organizations: {
    name: string;
    domain: string | null;
    kind: string | null;
    current_msp_id: string | null;
  } | null;
};

export default async function DraftPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const supabase = await createClient();
  // Every read on this page is scoped to the workspace on screen — RLS alone
  // spans all of a member's workspaces (028's contract: the app filters).
  const workspaceId = await currentWorkspaceId();
  // ?run=<id> from a run's timeline entry narrows drafting to that run's records.
  const scope = await loadRunScope(supabase, (await searchParams).run ?? null);

  // Draft eligibility is the ONE shared definition (lib/journey): has an
  // address, sourcing gate passed, not suppressed, no live planned touch. The
  // home hero, the tiles, and this page all read the same set, so they can
  // never drift apart.
  const eligible = await draftEligibleContactIds(supabase, workspaceId);
  const inScope = scope ? new Set(scope.contactIds) : null;
  const ids = inScope ? [...eligible].filter((id) => inScope.has(id)) : [...eligible];

  const { data } = ids.length
    ? await supabase
        .from("contacts")
        .select(
          "id, full_name, persona, title, city, email, linkedin_url, organizations(name, domain, kind, current_msp_id)",
        )
        .in("id", ids)
        .is("deleted_at", null)
    : { data: [] };
  const rows = (data ?? []) as unknown as Row[];

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

  // Each contact's latest usable hook (canonical definition in
  // lib/hooks/usable.ts) rides into the builder rows, so the drafting prompt
  // carries the verified claim (or the honest fallback angle) and the import
  // can stamp touches.hook_id. Contacts without one still draft — the no-hook
  // arm is the rent check's control group, not an error.
  const hooks = await usableHooksByContact(supabase, workspaceId);

  const contacts: DraftContact[] = rows
    .map((r) => {
      const hook = hooks.get(r.id) ?? null;
      return {
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
        hook_id: hook?.id ?? null,
        hook_text: hook?.text ?? null,
        hook_source_url: hook?.source_url ?? null,
        hook_kind: hook?.kind ?? null,
        fallback_angle: hook?.fallback_angle ?? null,
      };
    })
    .filter((c) => c.channels.length > 0);

  // Nothing draftable: diagnose why and point at the stage that unblocks it,
  // instead of a dead-end "run enrichment first".
  if (contacts.length === 0) {
    const [
      { count: totalContacts },
      { count: withAddress },
      { count: queued },
      { count: pendingEnrichment },
    ] = await Promise.all([
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null)
        .or("email.not.is.null,linkedin_url.not.is.null"),
      // Join live contacts so an orphaned touch of a soft-deleted contact
      // can't trigger the "everything is queued" branch below.
      supabase
        .from("touches")
        .select("id, contacts!inner(id)", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "planned")
        .eq("direction", "outbound")
        .is("deleted_at", null)
        .is("contacts.deleted_at", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null)
        .eq("enrichment_status", "pending"),
    ]);

    let reason: { text: string; href: string; cta: string };
    // Under a run scope the global diagnostics ("no contacts exist") would be
    // wrong — the database may be full, just not with this run's records.
    if (scope) {
      reason = {
        text: `Nothing from run ${scope.code ?? "this run"} is ready to draft. Its contacts may still need enrichment, a hook, or their gate — or they already have drafts queued. Clear the run filter to draft across every eligible contact.`,
        href: `/runs/${scope.runId}`,
        cta: "Open this run's records",
      };
    } else if ((totalContacts ?? 0) === 0) {
      reason = {
        text: "There are no contacts in the system yet. Drafting starts with a sourcing run.",
        href: "/source",
        cta: "Start a sourcing run (step 1)",
      };
    } else if ((queued ?? 0) > 0) {
      // Contacts with addresses exist, but every draftable one already has a
      // draft waiting in the send queue.
      reason = {
        text: "Every draftable contact already has a message in the send queue. Approve and send those, or use Send back to drafting there to regenerate them.",
        href: "/draft/queue",
        cta: "Open the send queue (step 6)",
      };
    } else if ((withAddress ?? 0) > 0) {
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
            Turn researched hooks into per-persona messages, then queue them for review.
          </p>
        </div>
        <RunScopeBanner scope={scope} basePath="/draft" noun="contacts" />
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

  return (
    <div className="flex flex-col gap-6">
      <RunScopeBanner scope={scope} basePath="/draft" noun="contacts" />
      <DraftBuilder contacts={contacts} />
    </div>
  );
}
