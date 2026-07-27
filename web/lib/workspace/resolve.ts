import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Workspace resolution for paths that have no signed-in user.
//
// The cron and the inbound webhooks run as the service role: there is no
// auth.uid(), so there is no membership to read a workspace from. They still
// have to name one, because as of migration 031 nothing supplies a default.
//
// Rather than guess, these resolve from the data where possible and fail loudly
// where not. A background job that cannot tell which tenant a row belongs to
// must stop, not pick one — the whole point of dropping the bridge defaults is
// that a misrouted write becomes an error instead of a silent cross-tenant leak.

/**
 * The only workspace, for jobs that are not workspace-aware yet.
 *
 * Correct exactly as long as one exists. The moment a second is created this
 * throws, which is the intended behaviour: it converts "the nightly cron
 * quietly filed another tenant's replies under Cohesium" into a visible
 * failure that names the work still to do (phase 4 makes sending per-user and
 * per-workspace).
 */
export async function soleWorkspaceId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from("workspaces").select("id").order("created_at");
  if (error) throw new Error(`Could not resolve workspace: ${error.message}`);
  const rows = data ?? [];
  if (!rows.length) throw new Error("No workspace exists.");
  if (rows.length > 1) {
    throw new Error(
      "More than one workspace exists, and this job is not workspace-aware yet. " +
        "It must select a workspace explicitly before it can run (tenancy phase 4).",
    );
  }
  return rows[0].id as string;
}

/** The workspace owning a contact — the natural source for anything derived from one. */
export async function workspaceOfContact(
  supabase: SupabaseClient,
  contactId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("contacts")
    .select("workspace_id")
    .eq("id", contactId)
    .maybeSingle();
  return (data?.workspace_id as string | undefined) ?? null;
}

/** The workspace owning a touch. */
export async function workspaceOfTouch(
  supabase: SupabaseClient,
  touchId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("touches")
    .select("workspace_id")
    .eq("id", touchId)
    .maybeSingle();
  return (data?.workspace_id as string | undefined) ?? null;
}
