import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/auth/secret";

// Write-back endpoint for the enrichment service (Clay). Clay POSTs enriched
// rows here; we fill the contact and flip enrichment_status. Auth is optional:
// when ENRICHMENT_WEBHOOK_SECRET is set, Clay must send it (Bearer or
// x-webhook-secret); when unset, write-backs are accepted without a token.
// Uses the service-role client because Clay isn't a logged-in user. Accepts a
// single object, an array, or { rows: [...] }.
//
// Row shape: { contact_id, email?, linkedin_url?, phone?, personalization?, status? }
// Extra fields (e.g. Clay's verification status) are preserved verbatim in the
// enrichment_events payload even though the contact update ignores them.

type Row = {
  contact_id?: string;
  email?: string | null;
  linkedin_url?: string | null;
  phone?: string | null;
  personalization?: string | null;
  status?: string | null;
};

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

export async function POST(req: Request) {
  // Auth is OPT-IN, by the operator's explicit decision (2026-07-27): with
  // ENRICHMENT_WEBHOOK_SECRET unset, write-backs are accepted with no token.
  // The accepted trade: this endpoint updates contacts' enrichment fields via
  // the service role, keyed by contact UUIDs — which do travel in the CSVs
  // handed to Clay — so anyone holding such a file could rewrite those
  // contacts' outreach addresses. Setting the env var turns the check on
  // (constant-time; Authorization: Bearer or x-webhook-secret).
  const secret = process.env.ENRICHMENT_WEBHOOK_SECRET;
  if (secret) {
    const header =
      req.headers.get("authorization") ?? req.headers.get("x-webhook-secret") ?? "";
    const provided = header.replace(/^Bearer\s+/i, "");
    if (!secretMatches(provided, secret)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rows: Row[] = Array.isArray(body)
    ? (body as Row[])
    : body && typeof body === "object" && Array.isArray((body as { rows?: Row[] }).rows)
      ? (body as { rows: Row[] }).rows
      : [body as Row];

  const supabase = createAdminClient();
  let updated = 0;
  const errors: string[] = [];
  const events: { contact_id: string; event: string; payload: unknown }[] = [];

  for (const r of rows) {
    if (!r.contact_id) {
      errors.push("missing contact_id");
      continue;
    }
    // Emails are stored lowercased so the reply/bounce capture's exact-match
    // lookups (which compare against lowercased IMAP senders) always resolve.
    // Migration 018 backfilled existing rows to lower(email).
    const email = clean(r.email)?.toLowerCase() ?? null;
    const linkedin = clean(r.linkedin_url);
    const status =
      clean(r.status) ?? (email || linkedin ? "enriched" : "failed");

    const patch: Record<string, unknown> = { enrichment_status: status };
    if (email) patch.email = email;
    if (linkedin) patch.linkedin_url = linkedin;
    const phone = clean(r.phone);
    if (phone) patch.phone = phone;
    const personalization = clean(r.personalization);
    if (personalization) patch.personalization = personalization;
    if (status === "enriched") patch.stage = "enriched";

    const { data, error } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", r.contact_id)
      .select("id");
    if (error) errors.push(`${r.contact_id}: ${error.message}`);
    else if (!data || data.length === 0)
      errors.push(`${r.contact_id}: no matching contact (check the contact_id mapping)`);
    else {
      updated++;
      // Provenance: the raw incoming row, verbatim — including any verification
      // or status fields Clay sends beyond what the contact update consumes.
      events.push({ contact_id: r.contact_id, event: "writeback", payload: r });
    }
  }

  if (events.length) {
    const { error } = await supabase.from("enrichment_events").insert(events);
    // The contact updates already landed; a provenance failure is reported, not
    // fatal (re-sending the write-back is safe either way).
    if (error) errors.push(`enrichment_events: ${error.message}`);
  }

  // Total failure (rows sent, nothing matched/updated) → 422 so callers like
  // Clay surface a red cell instead of a green "200" that hides a broken
  // contact_id mapping. Partial success stays 200: per-row errors are listed
  // and re-sending is safe (rows stay pending until a valid write-back).
  const status = rows.length > 0 && updated === 0 && errors.length > 0 ? 422 : 200;
  return NextResponse.json({ updated, errors }, { status });
}
