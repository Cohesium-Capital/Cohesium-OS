import { createClient } from "@/lib/supabase/server";
import { ImportForm, type MspOption } from "./import-form";

// Server component: load MSPs so a customer import can be attributed to one (which
// enables per-MSP yield tracking). ?target=<id> (from the Source shortcut)
// preselects customer kind + that MSP.
export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("kind", "msp")
    .order("name");

  return (
    <ImportForm
      msps={(data as MspOption[]) ?? []}
      initialTargetMspId={sp.target ?? null}
    />
  );
}
