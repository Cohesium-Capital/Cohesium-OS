import { createClient } from "@/lib/supabase/server";
import { PromptBuilder } from "./prompt-builder";
import type { Msp } from "@/lib/sourcing/prompts";

// Server component: load already-sourced MSPs so the "find customers for these
// MSPs" mode can target them. ?msp=<id> (from the MSP dashboard shortcut)
// pre-selects that MSP and the find-customers mode.
export default async function SourcePage({
  searchParams,
}: {
  searchParams: Promise<{ msp?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("id, name, domain")
    .eq("kind", "msp")
    .order("name");

  return <PromptBuilder msps={(data as Msp[]) ?? []} initialMspId={sp.msp ?? null} />;
}
