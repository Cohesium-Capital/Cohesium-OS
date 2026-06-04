import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// CSV of contacts still pending enrichment, for loading into Clay. Authenticated
// by the user session (a founder hits this from the app). Clay enriches and
// echoes contact_id back to POST /api/enrichment.

type Row = {
  id: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null } | null;
};

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

  const { data, error } = await supabase
    .from("contacts")
    .select(
      "id, full_name, title, persona, linkedin_url, organizations!inner(name, domain)",
    )
    .eq("enrichment_status", "pending");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as Row[];
  const header = [
    "contact_id",
    "full_name",
    "title",
    "persona",
    "company_name",
    "company_domain",
    "linkedin_url",
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
