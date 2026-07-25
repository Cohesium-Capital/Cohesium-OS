/**
 * One-off reconciliation: find LinkedIn touches still sitting as `planned` in
 * Cohesium whose contact is ALREADY a lead in the HeyReach campaign. This
 * clears out stragglers from before the partial-send fix, where a >100-lead
 * push had early batches land in HeyReach but the whole send errored out,
 * leaving already-added leads in the queue (clutter + a one-time double-send
 * risk on the next push).
 *
 * Redesign-era semantics (post redesign/demo-v1): matches are marked `queued`
 * with scheduled_at — never `sent` — because lead-add only queues inside
 * HeyReach; the SENT webhook flips queued -> sent when the request truly goes
 * out. Soft-deleted touches/contacts are ignored, and a contact who already
 * has a live queued/sent/delivered/replied linkedin touch is skipped: their
 * planned row is an intentional re-draft, not a straggler.
 *
 * It pages the campaign's existing leads and matches them to planned linkedin
 * touches by LinkedIn profile handle (the /in/<slug> part, normalized).
 *
 * Usage (dry run — prints what it WOULD mark, changes nothing):
 *   npx tsx --env-file=.env.local scripts/reconcile-heyreach.ts
 * Apply:
 *   npx tsx --env-file=.env.local scripts/reconcile-heyreach.ts --apply
 *
 * Reads: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *        HEYREACH_API_KEY, HEYREACH_CAMPAIGN_ID.
 */
import { createClient } from "@supabase/supabase-js";

const LEADS_URL = "https://api.heyreach.io/api/public/campaign/GetLeadsFromCampaign";
const PAGE = 100;

// Reduce a LinkedIn URL to a stable match key: the /in/<handle> slug, lowercased
// and stripped of protocol, www, query, hash, and trailing slash. Falls back to
// the normalized path when there's no /in/ segment (e.g. sales navigator URLs).
function linkedinKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const m = s.match(/\/in\/([^/]+)/);
  return m ? m[1] : s;
}

// The lead's profile URL can live under a few field names / nesting depending on
// the endpoint version, so probe the likely spots.
function profileUrlOf(item: unknown): string | null {
  const cand = (o: unknown): string | null => {
    if (!o || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    for (const k of ["profileUrl", "linkedInUserProfileUrl", "linkedin_url", "profile_url", "linkedinUrl"]) {
      if (typeof r[k] === "string" && r[k]) return r[k] as string;
    }
    return null;
  };
  const rec = item as Record<string, unknown>;
  return cand(item) ?? cand(rec?.linkedInUserProfile) ?? cand(rec?.lead) ?? cand(rec?.profile);
}

async function fetchCampaignLeadKeys(apiKey: string, campaignId: number): Promise<Set<string>> {
  const keys = new Set<string>();
  let offset = 0;
  let total = Infinity;
  let firstItemDumped = false;

  while (offset < total) {
    const res = await fetch(LEADS_URL, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId, offset, limit: PAGE }),
    });
    if (!res.ok) {
      throw new Error(`HeyReach GetLeadsFromCampaign ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { items?: unknown[]; totalCount?: number };
    const items = json.items ?? [];
    total = typeof json.totalCount === "number" ? json.totalCount : items.length;

    if (!firstItemDumped && items.length) {
      // Confirm the shape once so field-name assumptions are visible in the log.
      console.log("Sample lead record from HeyReach:\n" + JSON.stringify(items[0], null, 2) + "\n");
      firstItemDumped = true;
    }

    for (const it of items) {
      const k = linkedinKey(profileUrlOf(it));
      if (k) keys.add(k);
    }
    console.log(`Fetched ${Math.min(offset + items.length, total)}/${total} campaign leads…`);
    if (!items.length) break;
    offset += items.length;
  }
  return keys;
}

type PlannedTouch = {
  id: string;
  contact_id: string;
  contacts: { linkedin_url: string | null; full_name: string | null } | null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hrKey = process.env.HEYREACH_API_KEY;
  const campaignId = Number(process.env.HEYREACH_CAMPAIGN_ID);
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!hrKey || !campaignId) {
    console.error("Set HEYREACH_API_KEY and HEYREACH_CAMPAIGN_ID.");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`Reading leads from HeyReach campaign ${campaignId}…`);
  const campaignKeys = await fetchCampaignLeadKeys(hrKey, campaignId);
  console.log(`\n${campaignKeys.size} unique LinkedIn profiles already in the campaign.\n`);

  const { data, error } = await supabase
    .from("touches")
    .select("id, contact_id, contacts!inner(linkedin_url, full_name)")
    .eq("status", "planned")
    .eq("direction", "outbound")
    .eq("channel", "linkedin")
    .is("deleted_at", null)
    .is("contacts.deleted_at", null);
  if (error) throw new Error(error.message);
  const planned = (data ?? []) as unknown as PlannedTouch[];
  console.log(`${planned.length} live planned LinkedIn touches in Cohesium.`);

  // A contact with a live in-flight/sent linkedin touch already has their send
  // record — their planned row is an intentional re-draft, not a straggler.
  const { data: inflight, error: ie } = await supabase
    .from("touches")
    .select("contact_id")
    .eq("direction", "outbound")
    .eq("channel", "linkedin")
    .in("status", ["queued", "sent", "delivered", "replied"])
    .is("deleted_at", null);
  if (ie) throw new Error(ie.message);
  const hasLiveSend = new Set((inflight ?? []).map((t) => t.contact_id as string));

  const matches = planned.filter((t) => {
    if (hasLiveSend.has(t.contact_id)) return false;
    const k = linkedinKey(t.contacts?.linkedin_url);
    return k !== null && campaignKeys.has(k);
  });

  console.log(`\n${matches.length} of them are ALREADY in HeyReach:\n`);
  for (const m of matches) {
    console.log(`  • ${m.contacts?.full_name ?? "(no name)"} — ${m.contacts?.linkedin_url}`);
  }

  if (!matches.length) {
    console.log("\nNothing to reconcile. Queue is clean.");
    return;
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to mark these ${matches.length} touches queued.`);
    return;
  }

  const nowIso = new Date().toISOString();
  const { error: ue } = await supabase
    .from("touches")
    .update({ status: "queued", scheduled_at: nowIso, provider: "heyreach" })
    .in("id", matches.map((m) => m.id));
  if (ue) throw new Error(`Update failed: ${ue.message}`);
  console.log(
    `\n✅ Marked ${matches.length} touches queued (SENT webhook will flip them to sent). They'll drop off the Draft queue.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
