"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { currentWorkspaceId } from "@/lib/workspace/context";

// Demonstrate-mode dataset: a clearly-fake, wipeable pipeline snapshot the
// spotlight tour walks a first-time user through. Every row is identifiable
// as demo by construction — org domains end in `.walkthrough.example`, batch
// labels start with `demo-tour`, interaction message_ids start with
// `demo-tour` — so the wipe can never touch real data, and demo contacts can
// never leak into a real send (emails end in .example) or a real Clay push
// (pending-enrichment demo contacts stay reviewed=false).
//
// Never touched here: settings, prompt_versions (only READ to stamp
// provenance), enrichment_events, and anything queue/send-shaped.

const DEMO_DOMAIN_SUFFIX = ".walkthrough.example";
const MARKER_DOMAIN = "hq.walkthrough.example"; // MSP org; presence == seeded
const LABEL_PREFIX = "demo-tour";
const MESSAGE_ID_PREFIX = "demo-tour";

const EVIDENCE = [
  { url: "https://hq.walkthrough.example/case-study", via: "sourcing" },
];

export type SeedDemoTourResult = { seeded: true; alreadySeeded?: boolean };
export type DemoTourStatus = { seeded: boolean };
export type WipeDemoTourResult = { wiped: true };

// Every route the tour visits; both actions refresh the lot.
const TOUR_PATHS = [
  "/",
  "/source",
  "/review",
  "/review/grade",
  "/personalize",
  "/draft",
  "/draft/queue",
  "/triage",
  "/outcomes",
  "/runs",
  "/msps",
];

function revalidateTourPaths() {
  for (const path of TOUR_PATHS) revalidatePath(path);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function daysAgoDate(days: number): string {
  return daysAgoIso(days).slice(0, 10); // YYYY-MM-DD for date columns
}

/** The active prompt version for a module, or null when none is registered. */
async function activePromptVersionId(
  supabase: SupabaseClient,
  module: "sourcing" | "personalization" | "drafting",
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("prompt_versions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("module", module)
    .eq("active", true)
    .is("retired_at", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

export async function demoTourStatus(): Promise<DemoTourStatus> {
  await requireUser();
  const supabase = await createClient();
  // Per workspace: the demo dataset is seeded, toured and wiped inside one
  // workspace, so another workspace's marker must not read as "already seeded".
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("workspace_id", await currentWorkspaceId())
    .eq("domain", MARKER_DOMAIN)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { seeded: Boolean(data) };
}

export async function seedDemoTour(): Promise<SeedDemoTourResult> {
  await requireUser();
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();

  // Idempotency guard: the marker MSP org is inserted first, so its presence
  // means a previous seed ran (or is mid-flight). Never double-seed.
  const { data: marker, error: markerError } = await supabase
    .from("organizations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("domain", MARKER_DOMAIN)
    .maybeSingle();
  if (markerError) throw new Error(markerError.message);
  if (marker) return { seeded: true, alreadySeeded: true };

  try {
    const outcome = await seedAll(supabase, workspaceId);
    if (outcome === "already") return { seeded: true, alreadySeeded: true };
  } catch (e) {
    // A partial seed would strand the marker and block re-seeding; roll back
    // whatever landed (the wipe is prefix/domain-scoped, so this is safe),
    // then surface the original failure.
    try {
      await wipeCore(supabase, workspaceId);
    } catch {
      // Rollback is best-effort; the original error matters more.
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  revalidateTourPaths();
  return { seeded: true };
}

export async function wipeDemoTour(): Promise<WipeDemoTourResult> {
  await requireUser();
  const supabase = await createClient();
  await wipeCore(supabase, await currentWorkspaceId());
  revalidateTourPaths();
  return { wiped: true };
}

// ---------------------------------------------------------------------------
// seeding
// ---------------------------------------------------------------------------

async function seedAll(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<"seeded" | "already"> {
  // ---------- 1. SOURCING: marker org + batch + run + orgs + contacts ----------

  // The marker MSP org goes in FIRST: its presence is the seeded flag, and its
  // unique domain makes a concurrent double-seed fail here, before anything
  // else lands — that specific failure means "someone else seeded", not error.
  const { data: msp, error: mspError } = await supabase
    .from("organizations")
    .insert({
      workspace_id: workspaceId,
      name: "Walkthrough Managed IT",
      domain: MARKER_DOMAIN,
      kind: "msp",
      is_acq_target: true,
      hq_city: "Harborview",
      hq_state: "VA",
      confidence: "high",
      source_url: "https://hq.walkthrough.example/about",
      reviewed: true,
      evidence: EVIDENCE,
      notes:
        "DEMO DATA for the guided walkthrough. Everything under *.walkthrough.example is fake and wipeable.",
    })
    .select("id")
    .single();
  if (mspError) {
    if (mspError.code === "23505") return "already"; // unique_violation: lost the race
    throw new Error(mspError.message);
  }

  const { data: sourcingBatch, error: batchError } = await supabase
    .from("batches")
    .insert({
      workspace_id: workspaceId,
      module: "sourcing",
      label: `${LABEL_PREFIX} sourcing`,
      gate_status: "open",
    })
    .select("id")
    .single();
  if (batchError) throw new Error(batchError.message);

  const sourcingPv = await activePromptVersionId(supabase, "sourcing", workspaceId);

  const { data: sourcingRun, error: runError } = await supabase
    .from("runs")
    .insert({
      workspace_id: workspaceId,
      module: "sourcing",
      prompt_version_id: sourcingPv,
      batch_id: sourcingBatch.id,
      executor: "copy_paste",
      provider_label: "demo",
      status: "review_ready",
      config: { demo: true },
      rendered_prompt: "demo",
      ingest_report: {
        note: "demo-tour seeded dataset — nothing was actually sourced",
      },
      started_at: daysAgoIso(3),
      finished_at: daysAgoIso(3),
    })
    .select("id")
    .single();
  if (runError) throw new Error(runError.message);

  const customerRows = [
      {
        name: "Bright Harbor Clinics",
        domain: `brightharbor${DEMO_DOMAIN_SUFFIX}`,
        kind: "customer",
        current_msp_id: msp.id,
        hq_city: "Harborview",
        hq_state: "VA",
        confidence: "high",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        evidence: EVIDENCE,
      },
      {
        name: "Cedar & Vine Accounting",
        domain: `cedarvine${DEMO_DOMAIN_SUFFIX}`,
        kind: "customer",
        current_msp_id: msp.id,
        hq_city: "Cedar Falls",
        hq_state: "VA",
        confidence: "high",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        evidence: EVIDENCE,
      },
      {
        name: "Northlake Logistics",
        domain: `northlake${DEMO_DOMAIN_SUFFIX}`,
        kind: "customer",
        current_msp_id: msp.id,
        hq_city: "Northlake",
        hq_state: "NC",
        confidence: "medium",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        evidence: EVIDENCE,
      },
    ];

  const { data: customers, error: custError } = await supabase
    .from("organizations")
    .insert(customerRows.map((r) => ({ ...r, workspace_id: workspaceId })))
    .select("id, domain");
  if (custError) throw new Error(custError.message);

  const orgId = (slug: string): string => {
    const row = customers?.find((o) => o.domain === `${slug}${DEMO_DOMAIN_SUFFIX}`);
    if (!row) throw new Error(`demo seed: missing customer org ${slug}`);
    return row.id;
  };
  const brightHarbor = orgId("brightharbor");
  const cedarVine = orgId("cedarvine");
  const northlake = orgId("northlake");

  // 8 contacts. Shared lineage: run_id + batch_id + evidence on every row.
  //   #1-4  enriched WITH .example emails (hookable + draftable + sendable-in-demo-only)
  //         — #2 Marcus Webb carries the DELIBERATELY WRONG TITLE
  //           ('Chief Pastry Officer'; really an IT Director) so the grading
  //           step of the tour has a real correction to make.
  //   #5-6  pending enrichment, email null, reviewed=false → NEVER Clay-eligible.
  //   #7-8  enriched via LinkedIn (no email), sampled=false / skipped_sampling
  //         — the unsampled riders that advance when the gate passes.
  const stamp = {
    workspace_id: workspaceId,
    batch_id: sourcingBatch.id,
    run_id: sourcingRun.id,
    evidence: EVIDENCE,
    stage: "sourced",
    source: "demo-tour",
  };
  const { data: contacts, error: contactError } = await supabase
    .from("contacts")
    .insert([
      {
        ...stamp,
        organization_id: brightHarbor,
        full_name: "Ana Delgado",
        persona: "owner",
        title: "Practice Owner",
        email: `ana@brightharbor${DEMO_DOMAIN_SUFFIX}`,
        linkedin_url: "https://linkedin.com/in/ana-delgado-walkthrough-example",
        city: "Harborview",
        enrichment_status: "enriched",
        confidence: "high",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: true,
        review_status: "pending_review",
      },
      {
        // The tour's correct-flow target: title is deliberately wrong.
        ...stamp,
        organization_id: brightHarbor,
        full_name: "Marcus Webb",
        persona: "head_of_it",
        title: "Chief Pastry Officer",
        email: `marcus@brightharbor${DEMO_DOMAIN_SUFFIX}`,
        linkedin_url: "https://linkedin.com/in/marcus-webb-walkthrough-example",
        city: "Harborview",
        enrichment_status: "enriched",
        confidence: "high",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: true,
        review_status: "pending_review",
      },
      {
        ...stamp,
        organization_id: cedarVine,
        full_name: "Priya Natarajan",
        persona: "owner",
        title: "Managing Partner",
        email: `priya@cedarvine${DEMO_DOMAIN_SUFFIX}`,
        linkedin_url: "https://linkedin.com/in/priya-natarajan-walkthrough-example",
        city: "Cedar Falls",
        enrichment_status: "enriched",
        confidence: "high",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: true,
        review_status: "pending_review",
      },
      {
        ...stamp,
        organization_id: northlake,
        full_name: "Tom Alvarez",
        persona: "head_of_it",
        title: "VP of Technology",
        email: `tom@northlake${DEMO_DOMAIN_SUFFIX}`,
        linkedin_url: "https://linkedin.com/in/tom-alvarez-walkthrough-example",
        city: "Northlake",
        enrichment_status: "enriched",
        confidence: "medium",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: true,
        review_status: "pending_review",
      },
      {
        // Pending enrichment: no email, reviewed=false → never Clay-eligible.
        ...stamp,
        organization_id: cedarVine,
        full_name: "June Park",
        persona: "head_of_it",
        title: "Systems Administrator",
        email: null,
        city: "Cedar Falls",
        enrichment_status: "pending",
        confidence: "medium",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: false,
        sampled: true,
        review_status: "pending_review",
      },
      {
        // Pending enrichment: no email, reviewed=false → never Clay-eligible.
        ...stamp,
        organization_id: northlake,
        full_name: "Omar Haddad",
        persona: "owner",
        title: "President",
        email: null,
        city: "Northlake",
        enrichment_status: "pending",
        confidence: "low",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: false,
        sampled: true,
        review_status: "pending_review",
      },
      {
        ...stamp,
        organization_id: brightHarbor,
        full_name: "Grace Lin",
        persona: "other",
        title: "Office Manager",
        email: null,
        linkedin_url: "https://linkedin.com/in/grace-lin-walkthrough-example",
        city: "Harborview",
        enrichment_status: "enriched",
        confidence: "medium",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: false,
        review_status: "skipped_sampling",
      },
      {
        ...stamp,
        organization_id: northlake,
        full_name: "Victor Osei",
        persona: "other",
        title: "Operations Lead",
        email: null,
        linkedin_url: "https://linkedin.com/in/victor-osei-walkthrough-example",
        city: "Northlake",
        enrichment_status: "enriched",
        confidence: "medium",
        source_url: "https://hq.walkthrough.example/case-study",
        reviewed: true,
        sampled: false,
        review_status: "skipped_sampling",
      },
    ])
    .select("id, full_name");
  if (contactError) throw new Error(contactError.message);

  const contactId = (name: string): string => {
    const row = contacts?.find((c) => c.full_name === name);
    if (!row) throw new Error(`demo seed: missing contact ${name}`);
    return row.id;
  };
  const ana = contactId("Ana Delgado");
  const marcus = contactId("Marcus Webb");
  const priya = contactId("Priya Natarajan");
  const tom = contactId("Tom Alvarez");
  const grace = contactId("Grace Lin");
  const victor = contactId("Victor Osei");

  // ---------- 2. HOOKS: batch + run + 6 hook rows ----------

  const { data: hooksBatch, error: hooksBatchError } = await supabase
    .from("batches")
    .insert({
      workspace_id: workspaceId,
      module: "personalization",
      label: `${LABEL_PREFIX} hooks`,
      gate_status: "open",
    })
    .select("id")
    .single();
  if (hooksBatchError) throw new Error(hooksBatchError.message);

  const personalizationPv = await activePromptVersionId(supabase, "personalization", workspaceId);

  const { data: hooksRun, error: hooksRunError } = await supabase
    .from("runs")
    .insert({
      workspace_id: workspaceId,
      module: "personalization",
      prompt_version_id: personalizationPv,
      batch_id: hooksBatch.id,
      executor: "copy_paste",
      provider_label: "demo",
      status: "review_ready",
      config: { demo: true },
      rendered_prompt: "demo",
      ingest_report: {
        note: "demo-tour seeded hooks — no research actually ran",
      },
      started_at: daysAgoIso(2),
      finished_at: daysAgoIso(2),
    })
    .select("id")
    .single();
  if (hooksRunError) throw new Error(hooksRunError.message);

  const hookStamp = {
    workspace_id: workspaceId,
    track: "customer",
    run_id: hooksRun.id,
    batch_id: hooksBatch.id,
    prompt_version_id: personalizationPv,
    status: "candidate",
  };
  // Six hooks on the six enriched contacts (one per contact per run — 020's
  // unique index). Which is which:
  //   Ana / Marcus / Priya / Tom — the 4 PLAUSIBLE sampled candidates the
  //     verify step should pass (specific claim + demo source URL + recent date).
  //   Grace — the deliberately GENERIC sampled candidate ('They have a
  //     website') the tour has the user REJECT with category 'generic'.
  //   Victor — the honest kind='none' fallback (sampled=false): no hook found,
  //     drafter gets a truthful angle instead of a fabrication temptation.
  const { data: hookRows, error: hooksError } = await supabase
    .from("hooks")
    .insert([
      {
        ...hookStamp,
        contact_id: ana,
        kind: "talk",
        text: "Spoke at the Harborview Clinic Ops Summit on keeping patient systems running through an EHR migration.",
        source_url: `https://brightharbor${DEMO_DOMAIN_SUFFIX}/news/ops-summit-recap`,
        source_published_at: daysAgoDate(45),
        sampled: true,
      },
      {
        ...hookStamp,
        contact_id: marcus,
        kind: "news",
        text: "Named in Bright Harbor's EMR rollout write-up as the lead on the cutover weekend.",
        source_url: `https://brightharbor${DEMO_DOMAIN_SUFFIX}/news/emr-rollout`,
        source_published_at: daysAgoDate(30),
        sampled: true,
      },
      {
        ...hookStamp,
        contact_id: priya,
        kind: "post",
        text: "Posted a tax-season retrospective on what broke in the firm's document workflow and how they patched it.",
        source_url: `https://cedarvine${DEMO_DOMAIN_SUFFIX}/news/tax-season-retro`,
        source_published_at: daysAgoDate(21),
        sampled: true,
      },
      {
        ...hookStamp,
        contact_id: tom,
        kind: "news",
        text: "Northlake announced its second warehouse comes online this fall, doubling the company's footprint.",
        source_url: `https://northlake${DEMO_DOMAIN_SUFFIX}/news/warehouse-two`,
        source_published_at: daysAgoDate(14),
        sampled: true,
      },
      {
        // The blatantly generic one — the tour's reject target.
        ...hookStamp,
        contact_id: grace,
        kind: "other",
        text: "They have a website",
        source_url: `https://brightharbor${DEMO_DOMAIN_SUFFIX}`,
        source_published_at: null,
        sampled: true,
      },
      {
        // The honest no-hook outcome with a truthful fallback angle.
        ...hookStamp,
        contact_id: victor,
        kind: "none",
        text: null,
        source_url: null,
        source_published_at: null,
        fallback_angle:
          "Operations lead at a regional logistics firm; open on how freight ops teams split responsibilities with an outside IT provider.",
        sampled: false,
      },
    ])
    .select("id, contact_id");
  if (hooksError) throw new Error(hooksError.message);

  const hookByContact = (id: string): string => {
    const row = hookRows?.find((h) => h.contact_id === id);
    if (!row) throw new Error("demo seed: missing hook row");
    return row.id;
  };

  // ---------- 3. DRAFTS: two planned, unapproved touches ----------

  const draftingPv = await activePromptVersionId(supabase, "drafting", workspaceId);

  const draftRows = [
    {
      contact_id: ana,
      channel: "email",
      direction: "outbound",
      sequence_step: 1,
      status: "planned",
      approved: false,
      track: "customer",
      hook_id: hookByContact(ana),
      prompt_version_id: draftingPv,
      subject: "your Clinic Ops Summit talk",
      body:
        "Hi Ana, cold email, so I'll keep it short. I'm a cofounder of Cohesium, an investment firm researching the managed IT market. We learn by talking with experienced operators about what matters and where the pain points still live. Caught the recap of your Clinic Ops Summit talk on keeping patient systems running through an EHR migration, and that is exactly the kind of perspective we value. Would you be open to fifteen minutes on how practices like Bright Harbor work with their IT provider? Not selling anything, just learning.\n\nBest,\nCohesium",
    },
    {
      contact_id: tom,
      channel: "linkedin",
      direction: "outbound",
      sequence_step: 1,
      status: "planned",
      approved: false,
      track: "customer",
      hook_id: hookByContact(tom),
      prompt_version_id: draftingPv,
      subject: null,
      body:
        "Hi Tom, researching how logistics firms work with managed IT providers (not selling anything). Saw the news on Northlake's second warehouse coming online. Would value your take on what a good IT partner does during a build-out. Open to a quick chat?",
    },
  ];

  const { error: draftsError } = await supabase
    .from("touches")
    .insert(draftRows.map((r) => ({ ...r, workspace_id: workspaceId })));
  if (draftsError) throw new Error(draftsError.message);

  // ---------- 4. REPLY / TRIAGE: one sent touch + two captured replies ----------

  // Deliberately left status='sent' (NOT 'replied'): the tour's triage step has
  // the user set the positive disposition, and THAT judgment is what should
  // move the outcomes numbers in front of them. prompt_version_id is stamped so
  // the touch rows up in draft_outcomes.
  const { data: sentTouch, error: sentError } = await supabase
    .from("touches")
    .insert({
      workspace_id: workspaceId,
      contact_id: priya,
      channel: "email",
      direction: "outbound",
      sequence_step: 1,
      status: "sent",
      sent_at: daysAgoIso(2),
      provider: "smtp",
      approved: true,
      approved_by: "demo",
      approved_at: daysAgoIso(2),
      track: "customer",
      hook_id: hookByContact(priya),
      prompt_version_id: draftingPv,
      subject: "quick question about IT at Cedar & Vine",
      body:
        "Hi Priya, cold email, acknowledged. I'm a cofounder of Cohesium, an investment firm learning how firms like yours work with managed IT providers. Your tax-season retrospective was a great read. Would value ten minutes of your perspective. Not selling anything.",
    })
    .select("id")
    .single();
  if (sentError) throw new Error(sentError.message);

  const interactionRows = [
    {
      // (a) the enthusiastic yes — triage's positive-disposition try-it.
      contact_id: priya,
      touch_id: sentTouch.id,
      channel: "email",
      source: "imap",
      occurred_at: daysAgoIso(1),
      raw_content:
        "Happy to chat, and honestly the timing is great since we are mid-review of our IT support contract. Send over a few times next week and I will grab one.",
      message_id: `${MESSAGE_ID_PREFIX}-reply-1`,
      disposition: null,
    },
    {
      // (b) the opt-out — triage's suppression-writing try-it.
      contact_id: marcus,
      channel: "email",
      source: "imap",
      occurred_at: daysAgoIso(0.5),
      raw_content: "Please unsubscribe me from these emails.",
      message_id: `${MESSAGE_ID_PREFIX}-reply-2`,
      disposition: null,
    },
  ];

  const { error: interactionsError } = await supabase
    .from("interactions")
    .insert(interactionRows.map((r) => ({ ...r, workspace_id: workspaceId })));
  if (interactionsError) throw new Error(interactionsError.message);

  // A pending auto-matcher suppression on a THIRD contact, so the tour's
  // confirm/revoke flow has a row to act on.
  const { error: suppressionError } = await supabase.from("suppressions").insert({
    contact_id: grace,
    reason: "auto_pending",
    status: "pending",
    source: "demo-tour",
    note: "Auto-matcher flagged a reply containing 'remove me' — confirm or revoke.",
    created_by: "demo-tour",
  });
  if (suppressionError) throw new Error(suppressionError.message);

  return "seeded";
}

// ---------------------------------------------------------------------------
// wiping
// ---------------------------------------------------------------------------

/**
 * Removes everything the seed (and the tour's judgments on top of it) created,
 * in FK-safe order. Every deletion is scoped by demo domain, label prefix, or
 * message_id prefix, so real data is untouchable by construction. Safe to run
 * twice — a second pass finds nothing.
 */
async function wipeCore(supabase: SupabaseClient, workspaceId: string) {
  // Resolve demo org + contact ids up front.
  const { data: orgs, error: orgsError } = await supabase
    .from("organizations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .like("domain", `%${DEMO_DOMAIN_SUFFIX}`);
  if (orgsError) throw new Error(orgsError.message);
  const orgIds = (orgs ?? []).map((o) => o.id);

  let contactIds: string[] = [];
  if (orgIds.length > 0) {
    const { data: demoContacts, error: contactsError } = await supabase
      .from("contacts")
      .select("id")
      .in("organization_id", orgIds);
    if (contactsError) throw new Error(contactsError.message);
    contactIds = (demoContacts ?? []).map((c) => c.id);
  }

  // 1. interactions — by message_id prefix AND via demo contacts (covers rows
  //    the tour logged manually without a demo message_id).
  {
    const { error } = await supabase
      .from("interactions")
      .delete()
      .eq("workspace_id", workspaceId)
      .like("message_id", `${MESSAGE_ID_PREFIX}%`);
    if (error) throw new Error(error.message);
  }
  if (contactIds.length > 0) {
    const { error } = await supabase
      .from("interactions")
      .delete()
      .in("contact_id", contactIds);
    if (error) throw new Error(error.message);
  }

  // 2. judgment + message rows hanging off demo contacts. Touches before hooks
  //    (touches.hook_id has no cascade); touch_edits cascade with touches;
  //    grades/suppressions/enrichment_events would cascade with contacts but
  //    are deleted explicitly for clarity.
  if (contactIds.length > 0) {
    for (const table of ["suppressions", "touches", "hooks", "grades"] as const) {
      const { error } = await supabase.from(table).delete().in("contact_id", contactIds);
      if (error) throw new Error(error.message);
    }

    // 3. contacts (cascade sweeps enrichment_events and any stragglers).
    const { error } = await supabase.from("contacts").delete().in("id", contactIds);
    if (error) throw new Error(error.message);
  }

  // 4. orgs — customers first (current_msp_id points at the demo MSP), then
  //    the MSP marker itself.
  if (orgIds.length > 0) {
    const { error: custError } = await supabase
      .from("organizations")
      .delete()
      .like("domain", `%${DEMO_DOMAIN_SUFFIX}`)
      .not("current_msp_id", "is", null);
    if (custError) throw new Error(custError.message);

    const { error: mspError } = await supabase
      .from("organizations")
      .delete()
      .like("domain", `%${DEMO_DOMAIN_SUFFIX}`);
    if (mspError) throw new Error(mspError.message);
  }

  // 5. demo batches + their gate decisions and runs (contacts/grades/hooks that
  //    referenced the runs are already gone).
  const { data: batches, error: batchesError } = await supabase
    .from("batches")
    .select("id")
    .like("label", `${LABEL_PREFIX}%`);
  if (batchesError) throw new Error(batchesError.message);
  const batchIds = (batches ?? []).map((b) => b.id);

  if (batchIds.length > 0) {
    const { error: gdError } = await supabase
      .from("gate_decisions")
      .delete()
      .in("batch_id", batchIds);
    if (gdError) throw new Error(gdError.message);

    const { error: runsError } = await supabase
      .from("runs")
      .delete()
      .in("batch_id", batchIds);
    if (runsError) throw new Error(runsError.message);

    const { error: delBatchesError } = await supabase
      .from("batches")
      .delete()
      .in("id", batchIds);
    if (delBatchesError) throw new Error(delBatchesError.message);
  }
}
