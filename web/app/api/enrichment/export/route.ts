import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchEligibleContacts } from "@/lib/enrichment/pending";

// CSV of contacts eligible for enrichment (pending + reviewed + not deleted +
// gate-passed batch — same filter as the Clay push), for loading into Clay.
// Authenticated by the user session (a founder hits this from the app). Clay
// enriches and echoes contact_id back to POST /api/enrichment.

function cell(v: string | null | undefined): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await fetchEligibleContacts(supabase);
  const header = [
    "contact_id",
    "full_name",
    "title",
    "persona",
    "company_name",
    "company_domain",
    "linkedin_url",
    "org_kind",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.full_name,
        r.title,
        r.persona,
        r.organizations?.name ?? "",
        r.organizations?.domain ?? "",
        r.linkedin_url,
        r.organizations?.kind ?? "",
      ]
        .map(cell)
        .join(","),
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pending-enrichment.csv"',
    },
  });
}
