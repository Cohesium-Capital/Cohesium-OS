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
// Like the CSV export, this does not change enrichment_status — rows stay
// "pending" until the write-back flips them to "enriched"/"failed". Configure
// the Clay table to dedupe on contact_id so a re-push doesn't duplicate work.

type ClayPendingRow = {
  id: string;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  linkedin_url: string | null;
  organizations: { name: string; domain: string | null } | null;
};

// Conservative concurrency + retry/backoff: Clay's webhook source rate-limits
// bursts (429), so a single-shot fan-out drops a large share of rows. We retry
// transient failures (429 / 5xx / network / timeout), honoring Retry-After.
const CLAY_PUSH_CONCURRENCY = 3;
const CLAY_PUSH_TIMEOUT_MS = 15_000;
const CLAY_PUSH_MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postClayRow(
  url: string,
  row: ClayPendingRow,
): Promise<{ ok: boolean; reason?: string }> {
  const body = JSON.stringify({
    contact_id: row.id,
    full_name: row.full_name,
    title: row.title,
    persona: row.persona,
    company_name: row.organizations?.name ?? null,
    company_domain: row.organizations?.domain ?? null,
    linkedin_url: row.linkedin_url,
  });

  let reason = "unknown";
  for (let attempt = 1; attempt <= CLAY_PUSH_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAY_PUSH_TIMEOUT_MS);
    let retryable = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (res.ok) return { ok: true };
      reason = `HTTP ${res.status}`;
      // 429 and 5xx are worth retrying; 4xx (other than 429) won't improve.
      retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < CLAY_PUSH_MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.random() * 250;
        await sleep(backoff);
        continue;
      }
      return { ok: false, reason };
    } catch (e) {
      reason = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
      if (attempt < CLAY_PUSH_MAX_ATTEMPTS) {
        await sleep(Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.random() * 250);
        continue;
      }
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason };
}

export async function pushPendingToClay(): Promise<{
  total: number;
  pushed: number;
  failed: number;
  error?: string;
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
  let pushed = 0;
  let cursor = 0;
  const reasons = new Map<string, number>();
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const { ok, reason } = await postClayRow(url!, row);
      if (ok) pushed++;
      else if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CLAY_PUSH_CONCURRENCY, rows.length) }, worker),
  );

  const failed = rows.length - pushed;
  // Surface the dominant failure reason so a partial push is diagnosable.
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { total: rows.length, pushed, failed, error: failed ? topReason : undefined };
}
