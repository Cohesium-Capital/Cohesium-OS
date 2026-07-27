import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

// Which workspace the operator is currently looking at.
//
// This is SCOPING, not security. RLS already guarantees you can only reach
// workspaces you belong to (migration 028); this decides which of those the UI
// is showing. Keeping the two separate is what lets switching be a cookie
// rather than a new JWT — see the header of 028 for why that matters.
//
// Every read here is validated against membership before it is trusted: a
// tampered cookie naming someone else's workspace resolves to the user's
// default instead, and even if it did not, RLS would return nothing.

const COOKIE = "cohesium_workspace";

export type Workspace = {
  id: string;
  name: string;
  role: string;
  is_default: boolean;
};

/** Every workspace the signed-in user belongs to, default first then by name. */
export async function myWorkspaces(): Promise<Workspace[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, is_default, workspaces(id, name)")
    .order("is_default", { ascending: false });
  if (error) return [];

  return ((data ?? []) as unknown as {
    role: string;
    is_default: boolean;
    workspaces: { id: string; name: string } | null;
  }[])
    .filter((m) => m.workspaces)
    .map((m) => ({
      id: m.workspaces!.id,
      name: m.workspaces!.name,
      role: m.role,
      is_default: m.is_default,
    }))
    .sort((a, b) =>
      a.is_default === b.is_default ? a.name.localeCompare(b.name) : a.is_default ? -1 : 1,
    );
}

/**
 * The workspace the UI should render. Null only when the user belongs to none,
 * which is a real state (invited but not yet added) the shell has to handle
 * rather than crash on.
 */
export async function currentWorkspace(): Promise<Workspace | null> {
  const all = await myWorkspaces();
  if (!all.length) return null;

  const jar = await cookies();
  const requested = jar.get(COOKIE)?.value;
  // The cookie is a preference, not a credential: honour it only when it names
  // a workspace this user actually belongs to.
  return all.find((w) => w.id === requested) ?? all[0];
}

/**
 * The id to stamp on writes and filter reads by. Throws rather than guessing:
 * a write that cannot name its workspace must fail loudly here, not land
 * somewhere plausible via a database default.
 */
export async function currentWorkspaceId(): Promise<string> {
  const ws = await currentWorkspace();
  if (!ws) {
    throw new Error(
      "No workspace. You are signed in but not a member of any workspace — ask an admin to add you.",
    );
  }
  return ws.id;
}

export { COOKIE as WORKSPACE_COOKIE };
