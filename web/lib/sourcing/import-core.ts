import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SourcingPayloadSchema,
  normalizeDomain,
  nameKey,
  contactNameMatch,
} from "../contracts";
import { isSampled } from "../grading/math";
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
  },
): Promise<ImportReport> {
  const batchId = input.batchId ?? null;
  const runId = input.runId ?? null;
  const sampleRate = input.sampleRate ?? 1;
  const requireEvidence = input.requireEvidence ?? false;
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
        `${withMsp} of ${orgs.length} rows name an MSP (current_msp_name), so these look like customers, not MSPs. Set Row kind to "Customers".`,
      );
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
        .insert(rejects.map((r) => ({ run_id: runId, payload: r.payload, reason: r.reason })));
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
  const mspIdByName = new Map<string, string>();
  if (input.kind === "customer") {
    const names = [
      ...new Set(orgs.map((o) => o.current_msp_name).filter(Boolean)),
    ] as string[];
    if (names.length) {
      const { data: existingMsps } = await supabase
        .from("organizations")
        .select("id, name")
        .eq("kind", "msp");
      existingMsps?.forEach((m) => mspIdByName.set(m.name.toLowerCase(), m.id));

      const missing = names.filter((n) => !mspIdByName.has(n.toLowerCase()));
      if (missing.length) {
        const stubRows = missing.map((n) => ({
          name: n,
          kind: "msp",
          is_acq_target: true,
          confidence: "low",
          reviewed: false,
        }));
        const { data: stubs, error } = await supabase
          .from("organizations")
          .insert(stubRows)
          .select("id, name");
        if (error) return fail(`Failed creating MSP references: ${error.message}`);
        stubs?.forEach((s) => mspIdByName.set(s.name.toLowerCase(), s.id));
        report.inserted.organizations += stubs?.length ?? 0;
        report.messages.push(
          `Created ${stubs?.length ?? 0} new MSP reference(s) from customer links (flagged, low confidence).`,
        );
      }
    }
  }
  const resolvedMspId = (o: (typeof orgs)[number]): string | null =>
    input.kind === "customer" && o.current_msp_name
      ? mspIdByName.get(o.current_msp_name.toLowerCase()) ?? null
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
    full_name: c.full_name ?? null,
    persona: c.persona,
    title: c.title ?? null,
    linkedin_url: c.linkedin_url ?? null,
    source_url: c.source_url ?? null,
    confidence: c.confidence,
    source: "sourced",
    stage: "sourced",
    enrichment_status: "pending",
    reviewed: false,
    // Eval-layer tagging. batch_id is null on the legacy direct path. sampled
    // defaults true and review_status pending_review; sampleContacts() below
    // demotes the unsampled to skipped_sampling when sampleRate < 1.
    batch_id: batchId,
    evidence: evidenceFrom(c.source_url),
  });

  // After a contact insert, mark which rows are sampled for grading (deterministic
  // FNV-1a on the contact id). At sampleRate ≥ 1 every row is sampled (the seeded
  // default), so this is a no-op fast path.
  const sampleContacts = async (ids: string[]): Promise<number> => {
    if (!ids.length || sampleRate >= 1) return ids.length;
    const sampled = ids.filter((id) => isSampled(id, sampleRate));
    const skipped = ids.filter((id) => !isSampled(id, sampleRate));
    if (skipped.length) {
      await supabase
        .from("contacts")
        .update({ sampled: false, review_status: "skipped_sampling" })
        .in("id", skipped);
    }
    return sampled.length;
  };

  // 3. Load existing orgs of this kind to match against (domain or name+MSP).
  type ExistingOrg = {
    id: string;
    name: string;
    domain: string | null;
    current_msp_id: string | null;
    hq_city: string | null;
    hq_state: string | null;
    source_url: string | null;
  };
  const { data: existingOrgs } = await supabase
    .from("organizations")
    .select("id, name, domain, current_msp_id, hq_city, hq_state, source_url")
    .eq("kind", input.kind);

  const keyOfExisting = (e: ExistingOrg) =>
    input.kind === "customer"
      ? `${nameKey(e.name)}|${e.current_msp_id ?? ""}`
      : nameKey(e.name);
  const byDomain = new Map<string, ExistingOrg>();
  const byKey = new Map<string, ExistingOrg>();
  for (const e of (existingOrgs as ExistingOrg[] | null) ?? []) {
    if (e.domain) byDomain.set(e.domain, e);
    const k = keyOfExisting(e);
    if (!byKey.has(k)) byKey.set(k, e);
  }

  // 4. Partition incoming rows: merge into an existing org, insert as new, or
  //    skip as an intra-payload duplicate.
  const seenDomain = new Set<string>();
  const seenKey = new Set<string>();
  const toInsert: typeof orgs = [];
  const toMerge: { existing: ExistingOrg; incoming: (typeof orgs)[number] }[] = [];
  for (const o of orgs) {
    const dk = o.domain;
    const nk = nameKeyOf(o);
    if ((dk && seenDomain.has(dk)) || seenKey.has(nk)) continue; // dup within payload
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
      for (const c of o.contacts) newContacts.push(contactRow(orgId, c));
    }
    if (newContacts.length) {
      const { data: ic, error: ce } = await supabase
        .from("contacts")
        .insert(newContacts)
        .select("id");
      if (ce) report.messages.push(`Contacts insert error: ${ce.message}`);
      else {
        report.inserted.contacts += ic?.length ?? 0;
        report.sampledCount += await sampleContacts((ic ?? []).map((r) => r.id));
      }
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
      const patch: Record<string, unknown> = {};
      if (!existing.domain && incoming.domain) patch.domain = incoming.domain;
      if (!existing.hq_city && incoming.hq_city) patch.hq_city = incoming.hq_city;
      if (!existing.hq_state && incoming.hq_state) patch.hq_state = incoming.hq_state;
      if (!existing.source_url && incoming.source_url) patch.source_url = incoming.source_url;
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
      if (me) report.messages.push(`Merged contacts error: ${me.message}`);
      else {
        report.inserted.contacts += mc?.length ?? 0;
        report.sampledCount += await sampleContacts((mc ?? []).map((r) => r.id));
      }
    }
  }

  if (!toInsert.length && !toMerge.length) {
    report.messages.push("Nothing new to import — every row already exists.");
  }

  report.flagged = toInsert.filter((o) => o.confidence === "low" || !o.domain).length;

  // 7. Log the run. new_for_target counts only genuinely-new orgs.
  const newForTarget = input.targetMspId
    ? insertedOrgs.filter((r) => r.current_msp_id === input.targetMspId).length
    : null;
  await supabase.from("sourcing_runs").insert({
    kind: input.kind,
    target_msp_id: input.targetMspId ?? null,
    inserted_orgs: report.inserted.organizations,
    inserted_contacts: report.inserted.contacts,
    skipped_duplicates: report.skippedDuplicates,
    new_for_target: newForTarget,
    created_by: input.createdBy ?? null,
  });

  report.batchId = batchId;
  return report;
}
