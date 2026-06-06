import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Write-back endpoint for the enrichment service (Clay). Clay POSTs enriched
// rows here; we fill the contact and flip enrichment_status. Authenticated by a
// shared secret (Clay isn't a logged-in user), so it uses the service-role
// client. Accepts a single object, an array, or { rows: [...] }.
//
// Row shape: { contact_id, email?, linkedin_url?, phone?, personalization?, status? }

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
  const secret = process.env.ENRICHMENT_WEBHOOK_SECRET;
  const header =
    req.headers.get("authorization") ?? req.headers.get("x-webhook-secret") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  for (const r of rows) {
    if (!r.contact_id) {
      errors.push("missing contact_id");
      continue;
    }
    const email = clean(r.email);
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
    else updated++;
  }

  return NextResponse.json({ updated, errors });
}
