import { createClient } from "@/lib/supabase/server";
import { PromptBuilder } from "./prompt-builder";
import type { Msp } from "@/lib/sourcing/prompts";

// Server component: load already-sourced MSPs so the "find customers for these
// MSPs" mode can target them directly.
export default async function SourcePage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("name, domain")
    .eq("kind", "msp")
    .order("name");

  return <PromptBuilder msps={(data as Msp[]) ?? []} />;
}
