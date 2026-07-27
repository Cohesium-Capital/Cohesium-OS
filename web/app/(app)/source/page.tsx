import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
import { RunSourceBuilder } from "./run-source-builder";
import type { Msp } from "@/lib/sourcing/prompts";

// Server component: load already-sourced MSPs so the "find customers for these
// MSPs" mode can target them. ?msp=<id> (from the MSP dashboard shortcut)
// pre-selects that MSP and the find-customers mode.
//
// Also counts what we already hold per kind. That count is what the pasted
// prompt's do-not-research list is drawn from, and it is capped — so showing it
// tells the operator how much of their exclusion list still fits, and when it
// is time to move to the runner instead.
export default async function SourcePage({
  searchParams,
}: {
  searchParams: Promise<{ msp?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  // The workspace on screen: another workspace's MSPs must not be offered as
  // targets, and its holdings must not inflate the exclusion-list counts.
  const workspaceId = await currentWorkspaceId();

  const [{ data }, mspCount, customerCount] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, domain")
      .eq("workspace_id", workspaceId)
      .eq("kind", "msp")
      .order("name"),
    supabase
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("kind", "msp"),
    supabase
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("kind", "customer"),
  ]);

  return (
    <RunSourceBuilder
      msps={(data as Msp[]) ?? []}
      initialMspId={sp.msp ?? null}
      knownCounts={{ msp: mspCount.count ?? 0, customer: customerCount.count ?? 0 }}
    />
  );
}
