import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
import { draftEligibleContactIds } from "@/lib/journey";
import { computeHookGate } from "@/lib/hooks/gate";
import { hookCoverage, hookTtlCutoff, HOOK_TTL_DAYS } from "@/lib/hooks/usable";
import type { PersonalizationContact } from "@/lib/modules/personalization";
import type { GateMetrics } from "@/lib/grading/gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PersonalizeBuilder } from "./personalize-builder";
import { VerifyQueue, type VerifyHook } from "./verify-queue";
import { applyScope, contactRunMap, loadRunScope } from "@/lib/runs/scope";
import { RunScopeBanner } from "@/components/run-scope-banner";

// Personalize (step 4): research ONE durable, verifiable hook per contact
// headed to drafting — a claim + source URL a human can check in ~30 seconds —
// or an explicit kind='none' row with an honest fallback angle. Hooks are
// sampled for verification BEFORE drafting consumes them, which is what makes
// drafting pure writing (no draft-time web research) and the hooks-vs-fallback
// rent check computable via touches.hook_id.

type ContactRow = {
  id: string;
  full_name: string | null;
  title: string | null;
  organizations: {
    name: string;
    domain: string | null;
    kind: string | null;
    current_msp_id: string | null;
  } | null;
};

type SampledHookRow = {
  id: string;
  batch_id: string | null;
  contact_id: string;
  text: string | null;
  kind: string;
  fallback_angle: string | null;
  source_url: string | null;
  source_published_at: string | null;
  track: string | null;
  created_at: string;
  contacts: {
    full_name: string | null;
    title: string | null;
    organizations: { name: string; domain: string | null; kind: string | null } | null;
  } | null;
  batches: { label: string } | null;
};

function gateVariant(s: string): "default" | "secondary" | "destructive" {
  if (s === "passed") return "default";
  if (s === "failed") return "destructive";
  return "secondary";
}

export default async function PersonalizePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const supabase = await createClient();
  // Everything on this page reads and sweeps within the workspace on screen —
  // RLS alone spans all of a member's workspaces (028's contract).
  const workspaceId = await currentWorkspaceId();
  // ?run=<id> arrives from a run's timeline entry: research hooks for THAT
  // run's contacts rather than everything waiting at this stage.
  const scope = await loadRunScope(supabase, (await searchParams).run ?? null);

  // Opportunistic TTL sweep: hooks rot, so any still-undecided candidate older
  // than the TTL flips to 'expired' on load. ONLY candidates — 'verified' is a
  // durable human judgment (its usability TTL is already enforced read-side in
  // usable.ts), and decided rows are never touched. Recompute the gate for
  // each affected batch so a batch wedged on expired-ungraded samples heals
  // here instead of waiting for a verdict that can never come.
  const { data: swept } = await supabase
    .from("hooks")
    .update({ status: "expired" })
    .eq("workspace_id", workspaceId)
    .eq("status", "candidate")
    .lt("created_at", hookTtlCutoff())
    .select("batch_id");
  const sweptBatchIds = [
    ...new Set((swept ?? []).map((r) => r.batch_id).filter(Boolean)),
  ] as string[];
  if (sweptBatchIds.length) {
    await Promise.all(sweptBatchIds.map((id) => computeHookGate(supabase, id)));
  }

  const [eligible, { data: contactData }, coverage, { data: sampledData }, { data: latestBatch }] =
    await Promise.all([
      draftEligibleContactIds(supabase, workspaceId),
      supabase
        .from("contacts")
        .select("id, full_name, title, organizations(name, domain, kind, current_msp_id)")
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null)
        .or("email.not.is.null,linkedin_url.not.is.null"),
      hookCoverage(supabase, workspaceId),
      supabase
        .from("hooks")
        .select(
          "id, batch_id, contact_id, text, kind, fallback_angle, source_url, source_published_at, track, created_at, contacts!inner(full_name, title, organizations(name, domain, kind)), batches(label)",
        )
        .eq("workspace_id", workspaceId)
        .eq("status", "candidate")
        .eq("sampled", true)
        .is("contacts.deleted_at", null)
        .order("batch_id", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("batches")
        .select("id, label, created_at")
        .eq("workspace_id", workspaceId)
        .eq("module", "personalization")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  // Contacts NEEDING hooks: draft-eligible, minus those holding a usable hook
  // (canonical definition in lib/hooks/usable.ts), minus those with a hook
  // still in flight (awaiting verdict or gate) — re-researching the latter
  // would only duplicate work.
  const needing = applyScope(
    ((contactData ?? []) as unknown as ContactRow[]).filter(
      (c) => eligible.has(c.id) && !coverage.usable.has(c.id) && !coverage.pending.has(c.id),
    ),
    scope,
    (c) => c.id,
  );

  // Resolve "customer of <MSP>" names for the prompt's current_msp lines.
  const mspIds = [
    ...new Set(needing.map((c) => c.organizations?.current_msp_id).filter(Boolean)),
  ] as string[];
  const mspName = new Map<string, string>();
  if (mspIds.length) {
    const { data: m } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", mspIds);
    m?.forEach((x) => mspName.set(x.id, x.name));
  }

  const toLine = (c: ContactRow): PersonalizationContact => ({
    contact_id: c.id,
    full_name: c.full_name,
    title: c.title,
    company_name: c.organizations?.name ?? "their company",
    company_domain: c.organizations?.domain ?? null,
    current_msp: c.organizations?.current_msp_id
      ? mspName.get(c.organizations.current_msp_id) ?? null
      : null,
  });

  // Track split, same rule as the Draft page: org kind 'msp' is the
  // acquisition track; 'customer' and legacy 'unknown' ride the customer track.
  const mspContacts = needing.filter((c) => c.organizations?.kind === "msp").map(toLine);
  const customerContacts = needing.filter((c) => c.organizations?.kind !== "msp").map(toLine);

  const sampledHooks = (sampledData ?? []) as unknown as SampledHookRow[];
  // Run identifier + date per hook, via its contact's lineage.
  const hookRunInfo = await contactRunMap(
    supabase,
    [...new Set(sampledHooks.map((h) => h.contact_id))],
  );
  const verifyHooks: VerifyHook[] = sampledHooks.map((h) => ({
    run_code: hookRunInfo.get(h.contact_id)?.code ?? null,
    run_id: hookRunInfo.get(h.contact_id)?.runId ?? null,
    run_at: hookRunInfo.get(h.contact_id)?.runAt ?? null,
    id: h.id,
    batch_id: h.batch_id,
    batch_label: h.batches?.label ?? "—",
    text: h.text,
    kind: h.kind,
    fallback_angle: h.fallback_angle,
    source_url: h.source_url,
    source_published_at: h.source_published_at,
    track: h.track,
    contact_name: h.contacts?.full_name ?? null,
    contact_title: h.contacts?.title ?? null,
    org_name: h.contacts?.organizations?.name ?? "—",
    org_domain: h.contacts?.organizations?.domain ?? null,
    org_kind: h.contacts?.organizations?.kind ?? null,
  }));

  // One gate per batch in the verify queue (plus the latest batch for the
  // banner), computed once up front; the queue updates entries per verdict.
  // Guard: only recompute batches that actually contain hooks — the latest
  // 'personalization' batch can predate the hooks table (the old
  // contacts-based flow), and a hook-count recompute would wrongly reopen it.
  let latestBatchId: string | null = latestBatch?.id ?? null;
  if (latestBatchId && !verifyHooks.some((h) => h.batch_id === latestBatchId)) {
    const { count } = await supabase
      .from("hooks")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", latestBatchId);
    if (!count) latestBatchId = null;
  }
  const batchIds = [
    ...new Set([...verifyHooks.map((h) => h.batch_id), latestBatchId].filter(Boolean)),
  ] as string[];
  const computed = await Promise.all(batchIds.map((id) => computeHookGate(supabase, id)));
  const metricsByBatch: Record<string, GateMetrics> = {};
  batchIds.forEach((id, i) => (metricsByBatch[id] = computed[i]));
  const latestMetrics = latestBatchId ? metricsByBatch[latestBatchId] : null;

  // Nothing to research: diagnose why and point at the stage that unblocks it.
  let builderEmpty: { text: string; href: string; cta: string } | null = null;
  if (needing.length === 0) {
    if (eligible.size === 0) {
      builderEmpty = {
        text: "No contact is draft-eligible yet — hooks are researched only for contacts already cleared to draft. Grade sourcing samples or finish enrichment first.",
        href: "/review/grade",
        cta: "Grade the samples (step 3)",
      };
    } else if (coverage.pending.size > 0) {
      builderEmpty = {
        text: `Every contact without a usable hook has one in flight — ${coverage.pending.size} awaiting verification or their batch gate. Verify the sampled hooks below to move them along.`,
        href: "/personalize#verify-queue",
        cta: "Verify sampled hooks ↓",
      };
    } else {
      builderEmpty = {
        text: "Every draft-eligible contact already holds a usable hook. Drafting can consume them now — it's pure writing from here.",
        href: "/draft",
        cta: "Draft messages (step 5)",
      };
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Personalize</h1>
        <p className="text-sm text-muted-foreground">
          Research one verifiable hook per contact — claim, source, date — or an honest
          &ldquo;no hook&rdquo; with a fallback angle. Verified hooks feed drafting; nothing
          is invented at draft time.
        </p>
      </div>

      <RunScopeBanner scope={scope} basePath="/personalize" noun="contacts" />

      {/* Latest batch gate banner */}
      {latestBatch && latestMetrics && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
          <span className="text-muted-foreground">Latest hook batch</span>
          <span className="font-medium">{latestBatch.label}</span>
          <Badge variant={gateVariant(latestMetrics.status)}>gate: {latestMetrics.status}</Badge>
          <span className="text-muted-foreground">
            verified {latestMetrics.gradedCount}/{latestMetrics.sampleSize} sampled
          </span>
          <span className="text-muted-foreground">
            rejected {latestMetrics.errorCount} ({(latestMetrics.errorRate * 100).toFixed(0)}%)
          </span>
          <span className="text-muted-foreground">
            threshold {(latestMetrics.threshold * 100).toFixed(0)}%
          </span>
          {coverage.pending.size > 0 && (
            <span className="ml-auto text-muted-foreground">
              {coverage.pending.size} hook{coverage.pending.size === 1 ? "" : "s"} in flight
            </span>
          )}
        </div>
      )}

      {builderEmpty ? (
        <div className="flex flex-col items-start gap-3 rounded-md border p-6">
          <p className="text-sm font-medium">Nothing to research</p>
          <p className="text-sm text-muted-foreground">{builderEmpty.text}</p>
          <Button nativeButton={false} render={<Link href={builderEmpty.href} />}>
            {builderEmpty.cta} →
          </Button>
        </div>
      ) : (
        <PersonalizeBuilder msp={mspContacts} customer={customerContacts} />
      )}

      {/* Verification queue: sampled hooks land here before drafting consumes
          them. TTL context so the operator knows why old hooks vanish. */}
      <div id="verify-queue" className="flex flex-col gap-2 scroll-mt-4">
        <div>
          <h2 className="text-lg font-semibold">Verify sampled hooks</h2>
          <p className="text-sm text-muted-foreground">
            Click the source, check the claim — supported AND specific to this person.
            Hooks expire after {HOOK_TTL_DAYS} days unused.
          </p>
        </div>
        <VerifyQueue hooks={verifyHooks} initialMetricsByBatch={metricsByBatch} />
      </div>
    </div>
  );
}
