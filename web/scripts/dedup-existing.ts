/**
 * One-off: merge existing duplicate customer rows that the old exact-match
 * importer let through. Groups customers by normalized name + MSP, keeps the
 * richest row (prefers one with a domain), folds missing fields and contacts
 * into it, and deletes the twins.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/dedup-existing.ts [--apply]
 * Without --apply it's a dry run (prints what it would merge).
 */
import { createClient } from "@supabase/supabase-js";
import { nameKey } from "../lib/contracts";

type Org = {
  id: string;
  name: string;
  domain: string | null;
  current_msp_id: string | null;
  hq_city: string | null;
  hq_state: string | null;
  source_url: string | null;
  created_at: string;
};

function fieldScore(o: Org): number {
  return (
    (o.domain ? 4 : 0) +
    (o.hq_city ? 1 : 0) +
    (o.hq_state ? 1 : 0) +
    (o.source_url ? 1 : 0)
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, domain, current_msp_id, hq_city, hq_state, source_url, created_at")
    .eq("kind", "customer");
  if (error) throw new Error(error.message);
  const customers = (data as Org[]) ?? [];

  // Group by normalized name + MSP.
  const groups = new Map<string, Org[]>();
  for (const c of customers) {
    const k = `${nameKey(c.name)}|${c.current_msp_id ?? ""}`;
    if (!nameKey(c.name)) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }

  let mergedGroups = 0;
  let removed = 0;

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    mergedGroups++;
    // Keeper: most complete, prefer a domain, then earliest created.
    const sorted = [...group].sort(
      (a, b) => fieldScore(b) - fieldScore(a) || a.created_at.localeCompare(b.created_at),
    );
    const keeper = sorted[0];
    const losers = sorted.slice(1);
    console.log(
      `merge ${group.length}: keep "${keeper.name}" (${keeper.domain ?? "no domain"}) <- ` +
        losers.map((l) => `"${l.name}"`).join(", "),
    );
    if (!apply) continue;

    // Fill keeper's null fields from losers.
    const patch: Record<string, unknown> = {};
    for (const f of ["domain", "hq_city", "hq_state", "source_url"] as const) {
      if (!keeper[f]) {
        const donor = losers.find((l) => l[f]);
        if (donor) patch[f] = donor[f];
      }
    }
    if (Object.keys(patch).length) {
      const { error: ue } = await supabase
        .from("organizations")
        .update(patch)
        .eq("id", keeper.id);
      if (ue) console.error(`  update keeper failed: ${ue.message}`);
    }

    const loserIds = losers.map((l) => l.id);
    // Move contacts to keeper, then dedup keeper's contacts by name.
    await supabase
      .from("contacts")
      .update({ organization_id: keeper.id })
      .in("organization_id", loserIds);
    const { data: kc } = await supabase
      .from("contacts")
      .select("id, full_name")
      .eq("organization_id", keeper.id);
    const seen = new Set<string>();
    const dupContactIds: string[] = [];
    for (const c of kc ?? []) {
      if (!c.full_name) continue;
      const nk = nameKey(c.full_name);
      if (seen.has(nk)) dupContactIds.push(c.id);
      else seen.add(nk);
    }
    if (dupContactIds.length) {
      await supabase.from("contacts").delete().in("id", dupContactIds);
    }
    // Delete loser orgs (cascades any remaining contacts — already moved).
    const { error: de } = await supabase
      .from("organizations")
      .delete()
      .in("id", loserIds);
    if (de) console.error(`  delete losers failed: ${de.message}`);
    removed += loserIds.length;
  }

  console.log(
    `\n${apply ? "Merged" : "Would merge"} ${mergedGroups} group(s)` +
      (apply ? `, removed ${removed} duplicate row(s).` : " (dry run; pass --apply)."),
  );
}

main();
