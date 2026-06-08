import { createClient } from "@/lib/supabase/server";
import type { DraftContact } from "@/lib/drafting/prompt";
import { DraftBuilder } from "./draft-builder";

type Row = {
  id: string;
  full_name: string | null;
  persona: string | null;
  title: string | null;
  city: string | null;
  email: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null; current_msp_id: string | null } | null;
};

// Contacts with at least one address (email or LinkedIn) are draftable. Channels
// are derived from which addresses exist.
export default async function DraftPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select(
      "id, full_name, persona, title, city, email, linkedin_url, organizations(name, domain, current_msp_id)",
    )
    .or("email.not.is.null,linkedin_url.not.is.null");

  const all = (data ?? []) as unknown as Row[];

  // Skip contacts that already have a drafted (planned) touch, so each batch
  // advances to fresh contacts.
  const { data: drafted } = await supabase
    .from("touches")
    .select("contact_id")
    .eq("status", "planned")
    .eq("direction", "outbound");
  const draftedIds = new Set((drafted ?? []).map((t) => t.contact_id));
  const rows = all.filter((r) => !draftedIds.has(r.id));

  const mspIds = [
    ...new Set(rows.map((r) => r.organizations?.current_msp_id).filter(Boolean)),
  ] as string[];
  const mspName = new Map<string, string>();
  if (mspIds.length) {
    const { data: m } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", mspIds);
    m?.forEach((x) => mspName.set(x.id, x.name));
  }

  const contacts: DraftContact[] = rows
    .map((r) => ({
      contact_id: r.id,
      full_name: r.full_name,
      persona: r.persona,
      title: r.title,
      company_name: r.organizations?.name ?? "their company",
      company_domain: r.organizations?.domain ?? null,
      city: r.city,
      current_msp: r.organizations?.current_msp_id
        ? mspName.get(r.organizations.current_msp_id) ?? null
        : null,
      channels: [
        ...(r.email ? (["email"] as const) : []),
        ...(r.linkedin_url ? (["linkedin"] as const) : []),
      ],
    }))
    .filter((c) => c.channels.length > 0);

  return <DraftBuilder contacts={contacts} />;
}
