import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SourcingPayloadSchema,
  type SourcedTpaLink,
  normalizeDomain,
  nameKey,
  contactNameMatch,
} from "../contracts";
import { isSampled } from "../grading/math";
import { loadOrgIndex, type OrgIndexRow } from "./known";
import { partitionAdvisorCandidates, mergeAdvisorLinks } from "./advisor-links";
import { type ImportKind, type ImportReport, EMPTY_REPORT } from "./types";

// Evidence for a sourced row: the provenance URL(s) backing the claim. Stored on
// organizations.evidence / contacts.evidence (jsonb). Mirrors Gradebook's
// evidence discipline against our source_url field.
type Evidence = { url: string; via: "sourcing" };
const evidenceFrom = (url: string | null | undefined): Evidence[] =>
  url && url.trim() ? [{ url: url.trim(), via: "sourcing" }] : [];

// Client-agnostic import engine. The web app calls this with a user-session
// client (RLS applies); a CLI/worker calls it with a service-role client. Keeping
// it free of Next.js imports lets it run headlessly (e.g. an automated sourcing
// fan-out) as well as from a server action.

function fail(error: string): ImportReport {
  return { ...EMPTY_REPORT, ok: false, error };
}

export async function importPayload(
  supabase: SupabaseClient,
  input: {
    rawText: string;
    kind: ImportKind;
    targetMspId?: string | null;
    createdBy?: string | null;
    // Run/eval-layer wiring (P2). When omitted, behaves like the legacy direct
    // import: no batch, no sampling, evidence not enforced.
    batchId?: string | null;
    runId?: string | null;
    sampleRate?: number; // fraction of inserted contacts flagged for grading
    requireEvidence?: boolean; // reject orgs lacking a source_url to rejected_ingest
    /** Workspace that owns every row this import writes. */
    workspaceId: string;
  },
): Promise<ImportReport> {
  const batchId = input.batchId ?? null;
  const runId = input.runId ?? null;
  const sampleRate = input.sampleRate ?? 1;
  const requireEvidence = input.requireEvidence ?? false;
  const workspaceId = input.workspaceId;
  const report: ImportReport = {
    ...EMPTY_REPORT,
    inserted: { organizations: 0, contacts: 0 },
    messages: [],
  };

  // 1. Parse + validate.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawText);
  } catch {
    return fail("That is not valid JSON. Paste the full JSON object the model returned.");
  }
  const result = SourcingPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return fail(`Validation failed — ${issues.join("; ")}`);
  }

  let orgs = result.data.organizations.map((o) => ({
    ...o,
    kind: input.kind,
    domain: normalizeDomain(o.domain),
  }));

  // Guard against the customers-imported-as-MSPs mistake: if most rows reference
  // an MSP, they are customers, not MSPs.
  if (input.kind === "msp") {
    const withMsp = orgs.filter((o) => o.current_msp_name).length;
    if (withMsp >= Math.ceil(orgs.length / 2)) {
      return fail(
        `${withMsp} of ${orgs.length} rows name a provider (current_msp_name), so these look like customers, not target companies. Set Row kind to "Customers".`,
      );
    }
  }

  // The channel-mode trap that costs the most: a provider that files as its own
  // affiliated firm arrives looking like a referral partner while ALREADY being
  // an acquisition target we hold. Inserting it would mint a second row for the
  // same company under a different kind, and — worse — put it in a track that
  // asks its owner to refer us to owners like themselves while we are courting
  // them directly. So match every advisor candidate against the targets this
  // workspace holds and hold the matches out for review instead.
  if (input.kind === "advisor") {
    const tpaIndex = await loadOrgIndex(supabase, "msp", workspaceId);
    const { partners, collisions } = partitionAdvisorCandidates(tpaIndex, orgs);
    orgs = partners;
    const advisorIsTpaRejects = collisions.map(({ candidate, target }) => ({
      payload: candidate,
      reason: `"${candidate.name}" is already held as a target company ("${target.name}") — a provider filing as its own affiliated firm, not a referral partner`,
    }));
    if (advisorIsTpaRejects.length) {
      await supabase.from("rejected_ingest").insert(
        advisorIsTpaRejects.map((r) => ({
          run_id: runId,
          workspace_id: workspaceId,
          payload: r.payload,
          reason: r.reason,
        })),
      );
      report.advisorIsTpa = advisorIsTpaRejects.length;
      report.messages.push(
        `${advisorIsTpaRejects.length} row(s) are companies we already hold as targets, not referral partners — held out and logged to rejected_ingest. Worth reading: a target that files as its own advisor is a signal about that target.`,
      );
    }
    if (!orgs.length) {
      report.messages.push("Every row resolved to a target company we already hold — nothing imported.");
      report.batchId = batchId;
      return report;
    }
  }

  // Evidence-required ingest (run path only): an org with no source_url is
  // unverifiable. Log it to rejected_ingest and drop it rather than poison the
  // dataset. The legacy direct-import path (requireEvidence=false) is unaffected.
  if (requireEvidence) {
    const kept: typeof orgs = [];
    const rejects: { payload: unknown; reason: string }[] = [];
    for (const o of orgs) {
      if (evidenceFrom(o.source_url).length) kept.push(o);
      else rejects.push({ payload: o, reason: "organization has no source_url (evidence)" });
    }
    if (rejects.length) {
      await supabase
        .from("rejected_ingest")
        .insert(rejects.map((r) => ({
          run_id: runId, workspace_id: workspaceId, payload: r.payload, reason: r.reason,
        })));
      report.rejected += rejects.length;
      report.messages.push(
        `${rejects.length} organization(s) dropped for missing evidence (logged to rejected_ingest).`,
      );
    }
    orgs = kept;
    if (!orgs.length) {
      report.messages.push("Every row lacked evidence — nothing imported.");
      report.batchId = batchId;
      return report;
    }
  }

  // 2. Resolve current_msp_name -> MSP id (creating flagged stubs for unknowns).
  //
  // Matched on nameKey, the SAME key the organization dedupe uses. This used to
  // compare name.toLowerCase(), which is a different rule, and the two disagreed
  // exactly where it hurt: nameKey collapses "The Retirement Advantage", "The
  // Retirement Advantage Inc" and "The Retirement Advantage (TRA)" to one key,
  // lowercase keeps all three apart. A customer naming its provider a shade
  // differently from the row we already held therefore minted a SECOND target
  // and split that provider's client list across the two — invisibly, because
  // both rows look reasonable on the Target Companies page.
  //
  // It bit within a single payload too: `names` de-duplicates raw strings, so
  // two customers citing the same provider from two Schedule C filings arrived
  // as two names and left as two stubs.
  const mspKey = (name: string): string =>
    // A name made entirely of noise words ("The Group") has an empty nameKey.
    // Falling back to the raw string keeps those distinct instead of collapsing
    // every one of them onto a single shared key.
    nameKey(name) || `raw:${name.trim().toLowerCase()}`;
  const mspIdByKey = new Map<string, string>();
  if (input.kind === "customer") {
    const names = [
      ...new Set(orgs.map((o) => o.current_msp_name).filter(Boolean)),
    ] as string[];
    if (names.length) {
      // loadOrgIndex rather than a bespoke select, for three reasons: it is the
      // very index the dedupe consults, so the stub rule and the merge rule
      // cannot drift apart again; it keys on nameKey with first-wins; and it
      // PAGES. The select this replaced was unbounded, and PostgREST silently
      // caps those at ~1000 rows — past that, providers we already held would
      // read as missing and mint duplicate stubs on every ingest.
      //
      // Scoped to the ingesting workspace: a name collision with another
      // workspace's MSP must create this workspace's own stub, not a
      // cross-tenant current_msp_id link.
      const mspIndex = await loadOrgIndex(supabase, "msp", workspaceId);
      mspIndex.byName.forEach((row, key) => mspIdByKey.set(key, row.id));

      // Collapse the incoming names by the same key before creating anything,
      // or the same-payload case above just mints its duplicates here instead.
      // First spelling wins and becomes the stub's name.
      const missing: string[] = [];
      const claimed = new Set<string>();
      for (const n of names) {
        const k = mspKey(n);
        if (mspIdByKey.has(k) || claimed.has(k)) continue;
        claimed.add(k);
        missing.push(n);
      }
      if (missing.length) {
        const stubRows = missing.map((n) => ({
          name: n,
          workspace_id: workspaceId,
          kind: "msp",
          is_acq_target: true,
          confidence: "low",
          reviewed: false,
        }));
        const { data: stubs, error } = await supabase
          .from("organizations")
          .insert(stubRows)
          .select("id, name");
        if (error) return fail(`Failed creating target company references: ${error.message}`);
        stubs?.forEach((s) => mspIdByKey.set(mspKey(s.name), s.id));
        report.inserted.organizations += stubs?.length ?? 0;
        report.messages.push(
          `Created ${stubs?.length ?? 0} new target company reference(s) from customer links — unconfirmed, low confidence until someone reviews them on the Target Companies page.`,
        );
      }
    }
  }
  const resolvedMspId = (o: (typeof orgs)[number]): string | null =>
    input.kind === "customer" && o.current_msp_name
      ? mspIdByKey.get(mspKey(o.current_msp_name)) ?? null
      : null;

  const nameKeyOf = (o: (typeof orgs)[number]): string =>
    input.kind === "customer"
      ? `${nameKey(o.name)}|${resolvedMspId(o) ?? ""}`
      : nameKey(o.name);

  const contactRow = (
    organizationId: string,
    c: (typeof orgs)[number]["contacts"][number],
  ) => ({
    organization_id: organizationId,
    workspace_id: workspaceId,
    full_name: c.full_name ?? null,
    persona: c.persona,
    title: c.title ?? null,
    linkedin_url: c.linkedin_url ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    source_url: c.source_url ?? null,
    confidence: c.confidence,
    source: "sourced",
    stage: "sourced",
    // A sourced contact that already has an email needs nothing from Clay, and
    // Clay eligibility keys off this field alone (see enrichment/pending.ts) —
    // leaving it 'pending' would spend a credit re-finding an address we were
    // handed. Note this turns on EMAIL only, not "any detail found" the way
    // enrichment ingest does: a contact with a LinkedIn URL but no address is
    // exactly who Clay is for, and most sourced contacts have one.
    enrichment_status: c.email ? "enriched" : "pending",
    reviewed: false,
    // Eval-layer tagging. batch_id/run_id are null on the legacy direct path;
    // run_id is the contact's sourcing lineage. sampled defaults true and
    // review_status pending_review; sampleContacts() below demotes the
    // unsampled to skipped_sampling when sampleRate < 1.
    batch_id: batchId,
    run_id: runId,
    evidence: evidenceFrom(c.source_url),
  });

  // After a contact insert, mark which rows are sampled for grading (deterministic
  // FNV-1a on the contact id). At sampleRate ≥ 1 every row is sampled (the seeded
  // default), so this is a no-op fast path.
  const sampleContacts = async (ids: string[]): Promise<number> => {
    if (!ids.length || sampleRate >= 1) return ids.length;
    let sampled = ids.filter((id) => isSampled(id, sampleRate));
    let skipped = ids.filter((id) => !isSampled(id, sampleRate));

    // A batch that samples ZERO records can never pass its gate: there is
    // nothing to grade, so resolveGate keeps it 'open' forever and every
    // contact in it is permanently blocked from enrichment and drafting.
    // Deterministic sampling makes that a real outcome on small batches — at
    // a 0.2 rate, a five-row batch selects nothing roughly a third of the time.
    // So the floor is one: always keep something gradeable.
    if (!sampled.length) {
      sampled = [ids[0]];
      skipped = ids.slice(1);
    }
    if (skipped.length) {
      await supabase
        .from("contacts")
        .update({ sampled: false, review_status: "skipped_sampling" })
        .in("id", skipped);
    }
    return sampled.length;
  };

  // 3. Load existing orgs of this kind to match against (domain or name+MSP).
  // Paged in loadOrgIndex: an unbounded select is capped by PostgREST max-rows
  // (~1000 by default) with no error, so past that many orgs this dedupe used
  // to silently stop matching and admit duplicates as new rows.
  type ExistingOrg = OrgIndexRow;
  const orgIndex = await loadOrgIndex(supabase, input.kind, workspaceId);
  const byDomain = orgIndex.byDomain;
  const byKey = input.kind === "customer" ? orgIndex.byNameAndMsp : orgIndex.byName;

  // 4. Partition incoming rows: merge into an existing org, insert as new, or
  //    skip as an intra-payload duplicate.
  const seenDomain = new Set<string>();
  const seenKey = new Set<string>();
  const toInsert: typeof orgs = [];
  const toMerge: { existing: ExistingOrg; incoming: (typeof orgs)[number] }[] = [];
  // Incoming row -> the organization id it ended up as, whether it was inserted
  // fresh or merged into one we held. The advisor link pass needs both, and
  // keying on the row object avoids re-deriving a match key a third time.
  const orgIdOf = new Map<(typeof orgs)[number], string>();
  // Rows collapsed as intra-payload duplicates. For most kinds they are simply
  // discarded, but an ADVISOR listed twice in one payload is the normal shape of
  // the data — one row per filing route — and its second row's edges are real.
  const payloadDupes: typeof orgs = [];
  for (const o of orgs) {
    const dk = o.domain;
    const nk = nameKeyOf(o);
    if ((dk && seenDomain.has(dk)) || seenKey.has(nk)) {
      payloadDupes.push(o);
      continue; // dup within payload
    }
    if (dk) seenDomain.add(dk);
    seenKey.add(nk);
    const match = (dk ? byDomain.get(dk) : undefined) ?? byKey.get(nk);
    if (match) toMerge.push({ existing: match, incoming: o });
    else toInsert.push(o);
  }
  report.skippedDuplicates = orgs.length - toInsert.length - toMerge.length;

  // 5. Insert genuinely-new orgs and all their contacts.
  let insertedOrgs: {
    id: string;
    domain: string | null;
    name: string;
    current_msp_id: string | null;
  }[] = [];
  if (toInsert.length) {
    const orgRows = toInsert.map((o) => ({
      name: o.name,
      workspace_id: workspaceId,
      domain: o.domain,
      kind: input.kind,
      is_acq_target: input.kind === "msp",
      current_msp_id: resolvedMspId(o),
      hq_city: o.hq_city ?? null,
      hq_state: o.hq_state ?? null,
      source_url: o.source_url ?? null,
      confidence: o.confidence,
      reviewed: false,
      evidence: evidenceFrom(o.source_url),
      // Only meaningful on the advisor kind; null everywhere else.
      advisor_firm_type: input.kind === "advisor" ? o.advisor_firm_type ?? null : null,
    }));
    const { data, error } = await supabase
      .from("organizations")
      .insert(orgRows)
      .select("id, domain, name, current_msp_id");
    if (error) return fail(`Insert failed: ${error.message}`);
    insertedOrgs = data ?? [];
    report.inserted.organizations += insertedOrgs.length;

    const idByDomain = new Map<string, string>();
    const idByKey = new Map<string, string>();
    insertedOrgs.forEach((r) => {
      if (r.domain) idByDomain.set(r.domain, r.id);
      const k =
        input.kind === "customer"
          ? `${nameKey(r.name)}|${r.current_msp_id ?? ""}`
          : nameKey(r.name);
      idByKey.set(k, r.id);
    });

    const newContacts: ReturnType<typeof contactRow>[] = [];
    for (const o of toInsert) {
      const orgId = (o.domain && idByDomain.get(o.domain)) || idByKey.get(nameKeyOf(o));
      if (!orgId) continue;
      orgIdOf.set(o, orgId);
      for (const c of o.contacts) newContacts.push(contactRow(orgId, c));
    }
    if (newContacts.length) {
      const { data: ic, error: ce } = await supabase
        .from("contacts")
        .insert(newContacts)
        .select("id");
      if (ce) {
        // A failed contact insert is a FAILED import, not a footnote: orgs
        // without their contacts would report success while the runner's whole
        // yield is missing, and the run would advance to review with nothing
        // gradeable in it.
        report.messages.push(
          `${report.inserted.organizations} organization(s) were inserted before the failure.`,
        );
        return {
          ...report,
          ok: false,
          error: `Contacts insert failed: ${ce.message}`,
          batchId,
        };
      }
      report.inserted.contacts += ic?.length ?? 0;
      report.sampledCount += await sampleContacts((ic ?? []).map((r) => r.id));
    }
  }

  // 6. Merge: enrich each matched existing org (fill null fields) and add any
  //    contacts it doesn't already have. This is how re-sourcing improves data
  //    instead of duplicating it.
  if (toMerge.length) {
    const mergeIds = toMerge.map((m) => m.existing.id);
    const { data: existingContacts } = await supabase
      .from("contacts")
      .select("organization_id, full_name")
      .in("organization_id", mergeIds);
    // org id -> existing contact names, for fuzzy person-level dedup.
    const namesByOrg = new Map<string, string[]>();
    (existingContacts ?? []).forEach((c) => {
      if (!c.full_name) return;
      const arr = namesByOrg.get(c.organization_id) ?? [];
      arr.push(c.full_name);
      namesByOrg.set(c.organization_id, arr);
    });

    const mergeContacts: ReturnType<typeof contactRow>[] = [];
    for (const { existing, incoming } of toMerge) {
      orgIdOf.set(incoming, existing.id);
      const patch: Record<string, unknown> = {};
      if (!existing.domain && incoming.domain) patch.domain = incoming.domain;
      if (!existing.hq_city && incoming.hq_city) patch.hq_city = incoming.hq_city;
      if (!existing.hq_state && incoming.hq_state) patch.hq_state = incoming.hq_state;
      if (!existing.source_url && incoming.source_url) patch.source_url = incoming.source_url;
      // A re-source that classifies a firm we had unclassified is the main way
      // this column ever gets filled, since classification lags the join.
      if (
        input.kind === "advisor" &&
        !existing.advisor_firm_type &&
        incoming.advisor_firm_type
      ) {
        patch.advisor_firm_type = incoming.advisor_firm_type;
      }
      // Evidence accumulates on merge — a re-source that corroborates an org
      // is provenance, not noise. Skip URLs the org already carries.
      const incomingEvidence = evidenceFrom(incoming.source_url);
      if (incomingEvidence.length) {
        const existingEvidence = Array.isArray(existing.evidence) ? existing.evidence : [];
        if (!existingEvidence.some((e) => e?.url === incomingEvidence[0].url)) {
          patch.evidence = [...existingEvidence, ...incomingEvidence];
        }
      }
      if (Object.keys(patch).length) {
        const { error } = await supabase
          .from("organizations")
          .update(patch)
          .eq("id", existing.id);
        if (error) report.messages.push(`Enrich "${existing.name}": ${error.message}`);
      }
      let names = namesByOrg.get(existing.id);
      if (!names) {
        names = [];
        namesByOrg.set(existing.id, names);
      }
      for (const c of incoming.contacts) {
        if (!c.full_name) continue; // don't add placeholder contacts on merge
        // Skip if we already have this person (fuzzy: Rob/Robert, Joe/Joseph).
        if (names.some((n) => contactNameMatch(n, c.full_name))) continue;
        names.push(c.full_name);
        mergeContacts.push(contactRow(existing.id, c));
      }
    }
    report.merged = toMerge.length;
    if (mergeContacts.length) {
      const { data: mc, error: me } = await supabase
        .from("contacts")
        .insert(mergeContacts)
        .select("id");
      if (me) {
        // Same rule as the new-org path: silently losing the merged contacts
        // must not read as success.
        return {
          ...report,
          ok: false,
          error: `Merged contacts insert failed: ${me.message}`,
          batchId,
        };
      }
      report.inserted.contacts += mc?.length ?? 0;
      report.sampledCount += await sampleContacts((mc ?? []).map((r) => r.id));
    }
  }

  // 6b. Advisor -> target edges. This runs AFTER both the insert and the merge
  //     passes, because a re-sourced advisor we already held still brings new
  //     edges and refreshed plan counts, and those are the point of the row.
  if (input.kind === "advisor") {
    // Resolve the named targets against the ones this workspace holds, by the
    // same nameKey the org dedupe uses. Deliberately NO stub creation, unlike
    // the customer path: a customer naming an unknown provider has found us a
    // new target, but an advisor naming an unknown provider has only told us it
    // works somewhere we do not operate. Minting a target from it would fill
    // the acquisition pipeline with companies nobody researched.
    const tpaIndex = await loadOrgIndex(supabase, "msp", workspaceId);
    const tpaIdByKey = new Map<string, string>();
    tpaIndex.byName.forEach((row, key) => tpaIdByKey.set(key, row.id));

    // Resolve the duplicates too, so both of an advisor's rows feed one set of
    // edges rather than the first silently winning.
    if (payloadDupes.length) {
      const idByDomain = new Map<string, string>();
      const idByKey = new Map<string, string>();
      orgIdOf.forEach((id, row) => {
        if (row.domain) idByDomain.set(row.domain, id);
        idByKey.set(nameKeyOf(row), id);
      });
      for (const d of payloadDupes) {
        const id = (d.domain && idByDomain.get(d.domain)) || idByKey.get(nameKeyOf(d));
        if (id) orgIdOf.set(d, id);
      }
    }

    // Group every row's edges under the organization it resolved to BEFORE
    // merging, so edges arriving on two rows of the same firm collapse by the
    // same rules as two edges on one row (schedule_c + schedule_a -> both).
    const linksByAdvisor = new Map<string, SourcedTpaLink[]>();
    const orgUrlByAdvisor = new Map<string, string | null>();
    let noLinkRows = 0;
    for (const o of orgs) {
      const advisorId = orgIdOf.get(o);
      if (!advisorId) continue;
      if (!o.tpa_links.length) {
        noLinkRows++;
        continue;
      }
      linksByAdvisor.set(advisorId, [...(linksByAdvisor.get(advisorId) ?? []), ...o.tpa_links]);
      if (!orgUrlByAdvisor.get(advisorId)) orgUrlByAdvisor.set(advisorId, o.source_url ?? null);
    }

    type LinkRow = {
      workspace_id: string;
      advisor_org_id: string;
      tpa_org_id: string;
      join_source: string;
      shared_plan_count: number;
      relation: string | null;
      evidence: Evidence[];
      updated_at: string;
    };
    const links = new Map<string, LinkRow>();
    const unmatchedNames = new Set<string>();
    // Stamped once for the whole import: a re-source refreshes plan counts, and
    // without this the upsert's UPDATE arm would leave updated_at at whatever
    // the first insert set, making a refreshed edge look untouched.
    const now = new Date().toISOString();

    for (const [advisorId, tpaLinks] of linksByAdvisor) {
      const { resolved, unmatched } = mergeAdvisorLinks(advisorId, tpaLinks, (name) =>
        tpaIdByKey.get(mspKey(name)),
      );
      unmatched.forEach((n) => unmatchedNames.add(n));
      // An edge's own source_url when the payload carries one, else the firm's.
      const urlByTarget = new Map<string, string>();
      for (const l of tpaLinks) {
        const id = tpaIdByKey.get(mspKey(l.tpa_name));
        if (id && l.source_url) urlByTarget.set(id, l.source_url);
      }
      for (const r of resolved) {
        links.set(`${r.advisorOrgId}|${r.tpaOrgId}`, {
          workspace_id: workspaceId,
          advisor_org_id: r.advisorOrgId,
          tpa_org_id: r.tpaOrgId,
          join_source: r.joinSource,
          shared_plan_count: r.sharedPlanCount,
          relation: r.relation,
          evidence: evidenceFrom(urlByTarget.get(r.tpaOrgId) ?? orgUrlByAdvisor.get(advisorId)),
          updated_at: now,
        });
      }
    }

    if (links.size) {
      const { data: written, error: linkError } = await supabase
        .from("advisor_tpa_links")
        .upsert([...links.values()], {
          onConflict: "workspace_id,advisor_org_id,tpa_org_id",
        })
        .select("id");
      if (linkError) {
        // The advisor rows without their edges are contactless in the sense that
        // matters: there is no referral basis to draft from. Fail loudly rather
        // than report a successful import of unusable rows.
        return {
          ...report,
          ok: false,
          error: `Advisor links insert failed: ${linkError.message}`,
          batchId,
        };
      }
      report.advisorLinks = written?.length ?? links.size;
    }
    if (unmatchedNames.size) {
      report.advisorLinksUnmatched = unmatchedNames.size;
      report.messages.push(
        `${unmatchedNames.size} named target compan(y/ies) are not in this workspace, so those links were skipped: ${[...unmatchedNames].slice(0, 5).join(", ")}${unmatchedNames.size > 5 ? ", …" : ""}. Source them as targets first if they belong here.`,
      );
    }
    if (noLinkRows) {
      report.messages.push(
        `${noLinkRows} advisor row(s) named no target company. They were imported but have no referral basis to draft from — review before sending.`,
      );
    }
  }

  if (!toInsert.length && !toMerge.length) {
    report.messages.push("Nothing new to import — every row already exists.");
  }

  report.needsChecking = toInsert.filter(
    (o) =>
      o.confidence === "low" ||
      !o.domain ||
      // An advisor with no edge to anything we hold cannot be drafted honestly.
      (input.kind === "advisor" && !o.tpa_links.length),
  ).length;

  // 7. Log the run. new_for_target counts only genuinely-new orgs.
  const newForTarget = input.targetMspId
    ? insertedOrgs.filter((r) => r.current_msp_id === input.targetMspId).length
    : null;
  const { error: logError } = await supabase.from("sourcing_runs").insert({
    kind: input.kind,
    workspace_id: workspaceId,
    // Ties the yield-log row to the run that produced it. Null on the direct
    // import path, which is how the Runs timeline tells a tracked run from a
    // legacy import that predates run tracking.
    run_id: runId,
    target_msp_id: input.targetMspId ?? null,
    inserted_orgs: report.inserted.organizations,
    inserted_contacts: report.inserted.contacts,
    skipped_duplicates: report.skippedDuplicates,
    new_for_target: newForTarget,
    created_by: input.createdBy ?? null,
  });
  // Not fatal — the records themselves landed — but a lost yield-log row
  // corrupts the MSP explored/exhausted accounting, so say so.
  if (logError) report.messages.push(`Yield log not recorded: ${logError.message}`);

  report.batchId = batchId;
  return report;
}
