"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { fetchEligibleContacts, type PendingContact } from "@/lib/enrichment/pending";
import { computeGate } from "@/lib/grading/gate";

// Mutations for the review grid. Run as the signed-in user (RLS applies) and
// revalidate the page so the grid reflects the change.

export async function setReviewed(ids: string[], reviewed: boolean) {
  if (!ids.length) return;
  const user = await requireUser();
  const supabase = await createClient();
  // Vet attribution: reviewed_by/reviewed_at describe the current reviewed=true
  // stamp, so un-reviewing clears them rather than recording the flip.
  const { error } = await supabase
    .from("contacts")
    .update({
      reviewed,
      reviewed_by: reviewed ? (user.email ?? user.id) : null,
      reviewed_at: reviewed ? new Date().toISOString() : null,
    })
    .in("id", ids);
  if (error) throw new Error(error.message);
  revalidatePath("/review");
}

// Soft delete: the row leaves every read path (deleted_at filters) but keeps
// its lineage and any enrichment_events. reason is a single shared note for
// the whole batch (e.g. "wrong ICP").
export async function deleteContacts(ids: string[], reason?: string) {
  if (!ids.length) return;
  await requireUser();
  const supabase = await createClient();
  // Fetch affected batches first: a soft-deleted sampled contact leaves the
  // gate's sample, so each touched batch must recompute immediately rather
  // than waiting for the next grade to trigger it.
  const { data: affected } = await supabase
    .from("contacts")
    .select("batch_id")
    .in("id", ids)
    .not("batch_id", "is", null);
  const { error } = await supabase
    .from("contacts")
    .update({
      deleted_at: new Date().toISOString(),
      delete_reason: reason?.trim() || null,
    })
    .in("id", ids);
  if (error) throw new Error(error.message);
  const batchIds = [...new Set((affected ?? []).map((r) => r.batch_id as string))];
  for (const batchId of batchIds) {
    await computeGate(supabase, batchId);
  }
  revalidatePath("/review");
}

// Push eligible contacts to Clay's table webhook source. This is the
// programmatic counterpart to the CSV export (/api/enrichment/export): Clay
// ingests one JSON record per request, runs its enrichment waterfall, then
// echoes contact_id back to POST /api/enrichment. The payload mirrors the export
// columns so the Clay table schema is identical whichever ingest you use.
//
// Like the CSV export, this does not change enrichment_status — rows stay
// "pending" until the write-back flips them to "enriched"/"failed". Configure
// the Clay table to dedupe on contact_id so a re-push doesn't duplicate work.

// Conservative concurrency + retry/backoff: Clay's webhook source rate-limits
// bursts (429), so a single-shot fan-out drops a large share of rows. We retry
// transient failures (429 / 5xx / network / timeout), honoring Retry-After.
const CLAY_PUSH_CONCURRENCY = 3;
const CLAY_PUSH_TIMEOUT_MS = 15_000;
const CLAY_PUSH_MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Built once per row and reused verbatim as the enrichment_events payload, so
// provenance records exactly what Clay received.
function clayPayload(row: PendingContact): Record<string, string | null> {
  return {
    contact_id: row.id,
    full_name: row.full_name,
    title: row.title,
    persona: row.persona,
    company_name: row.organizations?.name ?? null,
    company_domain: row.organizations?.domain ?? null,
    linkedin_url: row.linkedin_url,
    // 'msp' (acquisition target) | 'customer' | 'unknown' (legacy default) —
    // lets the Clay table branch enrichment/messaging by audience.
    org_kind: row.organizations?.kind ?? null,
  };
}

async function postClayRow(
  url: string,
  payload: Record<string, string | null>,
): Promise<{ ok: boolean; reason?: string }> {
  const body = JSON.stringify(payload);

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

// contactIds scopes the push (the grid's selection); an empty array means "all
// eligible" (the explicit push-all button). Either way the eligibility filter
// in fetchEligibleContacts is the authority — ineligible ids are dropped, so an
// unvetted or gate-blocked contact can never reach the production Clay table.
export async function pushPendingToClay(contactIds: string[]): Promise<{
  total: number;
  pushed: number;
  failed: number;
  error?: string;
}> {
  await requireUser();
  const url = process.env.CLAY_TABLE_WEBHOOK_URL;
  if (!url) throw new Error("CLAY_TABLE_WEBHOOK_URL is not set.");

  const supabase = await createClient();
  const rows = await fetchEligibleContacts(
    supabase,
    contactIds.length ? contactIds : undefined,
  );
  if (!rows.length) return { total: 0, pushed: 0, failed: 0 };

  // Fixed-size worker pool over a shared cursor — bounded concurrency without a
  // dependency.
  let cursor = 0;
  const reasons = new Map<string, number>();
  const pushedEvents: { contact_id: string; event: string; payload: unknown }[] = [];
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const payload = clayPayload(row);
      const { ok, reason } = await postClayRow(url!, payload);
      if (ok) pushedEvents.push({ contact_id: row.id, event: "pushed", payload });
      else if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CLAY_PUSH_CONCURRENCY, rows.length) }, worker),
  );

  // Provenance: one 'pushed' event per contact Clay actually accepted, carrying
  // the exact fields sent. A failed insert doesn't undo the push, so report it
  // instead of throwing away the counts.
  let provenanceError: string | undefined;
  for (let i = 0; i < pushedEvents.length; i += 500) {
    const { error } = await supabase
      .from("enrichment_events")
      .insert(pushedEvents.slice(i, i + 500));
    if (error) {
      provenanceError = `pushed, but recording provenance failed: ${error.message}`;
      break;
    }
  }

  const pushed = pushedEvents.length;
  const failed = rows.length - pushed;
  // Surface the dominant failure reason so a partial push is diagnosable.
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    total: rows.length,
    pushed,
    failed,
    error: provenanceError ?? (failed ? topReason : undefined),
  };
}
