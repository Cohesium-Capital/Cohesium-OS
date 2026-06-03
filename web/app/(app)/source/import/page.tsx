import { createClient } from "@/lib/supabase/server";
import { ImportForm, type MspOption } from "./import-form";

// Server component: load MSPs so a customer import can be attributed to one (which
// enables per-MSP yield tracking).
export default async function ImportPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("kind", "msp")
    .order("name");

  return <ImportForm msps={(data as MspOption[]) ?? []} />;
}
