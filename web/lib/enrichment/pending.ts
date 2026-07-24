import type { SupabaseClient } from "@supabase/supabase-js";

// Shared fetch for "pending enrichment" contacts, used by both the Clay push
// (server action) and the CSV export (route handler).
//
// An unbounded .select() is capped by PostgREST's max-rows (Supabase defaults to
// ~1000), which silently truncates a large pending set — the push/export then
// only covers part of it with no error. We page explicitly instead: take an
// exact count, then walk fixed-size windows ordered by a stable key, advancing
// by the number of rows actually returned (so it stays correct even if the
// server cap is smaller than the page size).

export type PendingContact = {
  id: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null } | null;
};

const SELECT = "id, full_name, title, persona, linkedin_url, organizations!inner(name, domain)";
const PAGE = 1000;

export async function fetchAllPendingContacts(
  supabase: SupabaseClient,
): Promise<PendingContact[]> {
  const { count, error: countError } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("enrichment_status", "pending");
  if (countError) throw new Error(countError.message);

  const total = count ?? 0;
  const all: PendingContact[] = [];
  let from = 0;
  while (all.length < total) {
    const { data, error } = await supabase
      .from("contacts")
      .select(SELECT)
      .eq("enrichment_status", "pending")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as PendingContact[];
    if (!batch.length) break; // safety: no progress (e.g. rows changed mid-walk)
    all.push(...batch);
    from += batch.length;
  }
  return all;
}
