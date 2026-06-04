import type { SupabaseClient } from "@supabase/supabase-js";
import { SourcingPayloadSchema, normalizeDomain, nameKey } from "../contracts";
import { type ImportKind, type ImportReport, EMPTY_REPORT } from "./types";

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
  },
): Promise<ImportReport> {
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

  const orgs = result.data.organizations.map((o) => ({
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

  // 3. Dedup: existing domains, plus name-keys for no-domain rows.
  const domains = [...new Set(orgs.map((o) => o.domain).filter(Boolean))] as string[];
  const existingDomains = new Set<string>();
  if (domains.length) {
    const { data } = await supabase
      .from("organizations")
      .select("domain")
      .in("domain", domains);
    data?.forEach((r) => r.domain && existingDomains.add(r.domain));
  }

  const existingNameKeys = new Set<string>();
  if (input.kind === "customer") {
    const { data } = await supabase
      .from("organizations")
      .select("name, current_msp_id")
      .eq("kind", "customer");
    data?.forEach((r) =>
      existingNameKeys.add(`${nameKey(r.name)}|${r.current_msp_id ?? ""}`),
    );
  } else {
    const { data } = await supabase
      .from("organizations")
      .select("name")
      .eq("kind", "msp");
    data?.forEach((r) => existingNameKeys.add(nameKey(r.name)));
  }

  const nameKeyOf = (o: (typeof orgs)[number]): string =>
    input.kind === "customer"
      ? `${nameKey(o.name)}|${resolvedMspId(o) ?? ""}`
      : nameKey(o.name);

  const seenDomain = new Set<string>();
  const seenNameKey = new Set<string>();
  const deduped = orgs.filter((o) => {
    if (o.domain) {
      if (existingDomains.has(o.domain) || seenDomain.has(o.domain)) return false;
      seenDomain.add(o.domain);
      return true;
    }
    const key = nameKeyOf(o);
    if (existingNameKeys.has(key) || seenNameKey.has(key)) return false;
    seenNameKey.add(key);
    return true;
  });
  report.skippedDuplicates = orgs.length - deduped.length;

  // 4. Insert organizations.
  let insertedOrgs:
    | { id: string; domain: string | null; name: string; current_msp_id: string | null }[]
    | null = [];
  if (deduped.length) {
    const orgRows = deduped.map((o) => ({
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
    }));
    const { data, error } = await supabase
      .from("organizations")
      .insert(orgRows)
      .select("id, domain, name, current_msp_id");
    if (error) return fail(`Insert failed: ${error.message}`);
    insertedOrgs = data ?? [];
    report.inserted.organizations += insertedOrgs.length;

    // 5. Insert contacts, mapped back to their org by domain or name-key.
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

    const contactRows: Record<string, unknown>[] = [];
    for (const o of deduped) {
      const orgId = (o.domain && idByDomain.get(o.domain)) || idByKey.get(nameKeyOf(o));
      if (!orgId) continue;
      for (const c of o.contacts) {
        contactRows.push({
          organization_id: orgId,
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
        });
      }
    }
    if (contactRows.length) {
      const { data: insertedContacts, error: contactErr } = await supabase
        .from("contacts")
        .insert(contactRows)
        .select("id");
      if (contactErr) report.messages.push(`Contacts insert error: ${contactErr.message}`);
      else report.inserted.contacts = insertedContacts?.length ?? 0;
    }
  } else {
    report.messages.push("Nothing new to import — every row already exists.");
  }

  report.flagged = deduped.filter((o) => o.confidence === "low" || !o.domain).length;

  // 6. Log the run.
  const newForTarget = input.targetMspId
    ? (insertedOrgs ?? []).filter((r) => r.current_msp_id === input.targetMspId).length
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

  return report;
}
