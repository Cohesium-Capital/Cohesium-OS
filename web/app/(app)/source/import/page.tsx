import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";
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
  // Scope to the workspace on screen, as /source and /msps already do. RLS only
  // bounds this to the workspaces the caller belongs to, so a member of two
  // tenants was offered BOTH tenants' targets here — and picking the wrong one
  // attributes the import's yield to another workspace's target company.
  const workspaceId = await currentWorkspaceId();
  const { data } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .eq("kind", "msp")
    .order("name");

  return (
    <ImportForm
      msps={(data as MspOption[]) ?? []}
      initialTargetMspId={sp.target ?? null}
    />
  );
}
