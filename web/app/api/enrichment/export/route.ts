import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  fetchEligibleContacts,
  markPushedToClay,
  type PendingContact,
} from "@/lib/enrichment/pending";

// CSV of contacts eligible for enrichment (pending + reviewed + not deleted +
// gate-passed batch + never sent — same filter as the Clay push), for loading
// into Clay. Authenticated by the user session (a founder hits this from the
// app). Clay enriches and echoes contact_id back to POST /api/enrichment.
//
// Downloading this CSV *is* a send: the rows go into Clay and spend credits, so
// the route stamps clay_pushed_at and records the same 'pushed' provenance the
// webhook push does. Without that, the export and the push each re-sent the
// other's rows, and the export left no trace at all. The link is rendered with
// prefetch={false} precisely because this GET has that effect.
//
// ?resend=1 re-includes contacts already sent to Clay (spends credits again).

function cell(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Mirrors the webhook push payload so the Clay table schema is identical
// whichever ingest is used — and so both paths log the same provenance.
function exportPayload(r: PendingContact): Record<string, string | null> {
  return {
    contact_id: r.id,
    full_name: r.full_name,
    title: r.title,
    persona: r.persona,
    company_name: r.organizations?.name ?? null,
    company_domain: r.organizations?.domain ?? null,
    linkedin_url: r.linkedin_url,
    org_kind: r.organizations?.kind ?? null,
  };
}

const HEADER = [
  "contact_id",
  "full_name",
  "title",
  "persona",
  "company_name",
  "company_domain",
  "linkedin_url",
  "org_kind",
];

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const resend = new URL(req.url).searchParams.get("resend") === "1";
  const rows = await fetchEligibleContacts(supabase, undefined, { includePushed: resend });

  const lines = [HEADER.join(",")];
  for (const r of rows) {
    const p = exportPayload(r);
    lines.push(HEADER.map((k) => cell(p[k])).join(","));
  }

  // Record and mark before handing over the file: once the CSV is in the
  // operator's hands we can't know whether it was loaded, so the conservative
  // assumption is that it was. Over-marking costs one explicit re-send;
  // under-marking costs Clay credits on every future push.
  if (rows.length) {
    const events = rows.map((r) => ({
      contact_id: r.id,
      event: "pushed",
      payload: exportPayload(r),
    }));
    for (let i = 0; i < events.length; i += 500) {
      await supabase.from("enrichment_events").insert(events.slice(i, i + 500));
    }
    await markPushedToClay(
      supabase,
      rows.map((r) => r.id),
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pending-enrichment.csv"',
    },
  });
}
