"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

// Mutations for the review grid. Run as the signed-in user (RLS applies) and
// revalidate the page so the grid reflects the change.

export async function setReviewed(ids: string[], reviewed: boolean) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("contacts")
    .update({ reviewed })
    .in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/review");
}

export async function deleteContacts(ids: string[]) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("contacts").delete().in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/review");
}

// Push every pending contact to Clay's table webhook source. This is the
// programmatic counterpart to the CSV export (/api/enrichment/export): Clay
// ingests one JSON record per request, runs its enrichment waterfall, then
// echoes contact_id back to POST /api/enrichment. The payload mirrors the export
// columns so the Clay table schema is identical whichever ingest you use.
//
// Successfully-pushed rows flip to enrichment_status "enriching" so repeated
// clicks don't re-send (and burn Clay credits); the write-back moves them on to
// "enriched"/"failed".

type ClayPendingRow = {
  id: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null } | null;
};

const CLAY_PUSH_CONCURRENCY = 5;
const CLAY_PUSH_TIMEOUT_MS = 15_000;

async function postClayRow(url: string, row: ClayPendingRow): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAY_PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: row.id,
        full_name: row.full_name,
        title: row.title,
        persona: row.persona,
        company_name: row.organizations?.name ?? null,
        company_domain: row.organizations?.domain ?? null,
        linkedin_url: row.linkedin_url,
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function pushPendingToClay(): Promise<{
  total: number;
  pushed: number;
  failed: number;
}> {
  await requireUser();
  const url = process.env.CLAY_TABLE_WEBHOOK_URL;
  if (!url) throw new Error("CLAY_TABLE_WEBHOOK_URL is not set.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(
      "id, full_name, title, persona, linkedin_url, organizations!inner(name, domain)",
    )
    .eq("enrichment_status", "pending");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as ClayPendingRow[];
  if (!rows.length) return { total: 0, pushed: 0, failed: 0 };

  // Fixed-size worker pool over a shared cursor — bounded concurrency without a
  // dependency.
  const succeeded: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (await postClayRow(url!, row)) succeeded.push(row.id);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CLAY_PUSH_CONCURRENCY, rows.length) }, worker),
  );

  if (succeeded.length) {
    const { error: updateError } = await supabase
      .from("contacts")
      .update({ enrichment_status: "enriching" })
      .in("id", succeeded);
    if (updateError) throw new Error(updateError.message);
    revalidatePath("/review");
  }

  return {
    total: rows.length,
    pushed: succeeded.length,
    failed: rows.length - succeeded.length,
  };
}
