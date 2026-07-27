"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { currentWorkspace, currentWorkspaceId } from "./context";
import { DEFAULT_PROFILE, type WorkspaceVocab, type DraftCopy } from "./identity";

// Administering a workspace: name, members, invites, and the prompt profile.
//
// Every one of these is enforced in the DATABASE by the admin policies in
// migrations 033 and 035, not here. The `assertAdmin` calls below exist to
// produce a readable message instead of an opaque RLS rejection — they are not
// the security boundary, and removing one would change the error text, not the
// outcome.
//
// That sentence was briefly untrue and worth remembering: workspace_profile
// shipped with a member-level write policy while this file assumed admin-only,
// so the app was the only thing enforcing it. 035 moved the check into the
// database where it belongs, and lib/db/rls.test.ts now asserts it.

async function assertAdmin(): Promise<string> {
  await requireUser();
  const ws = await currentWorkspace();
  if (!ws) throw new Error("You are not a member of any workspace.");
  if (ws.role !== "admin") {
    throw new Error(`Only an admin of ${ws.name} can change this.`);
  }
  return ws.id;
}

const refresh = () => {
  revalidatePath("/settings");
  revalidatePath("/", "layout");
};

/** Create a workspace and become its admin. Returns the new id. */
export async function createWorkspace(name: string): Promise<string> {
  await requireUser();
  const clean = name.trim();
  if (!clean) throw new Error("Give the workspace a name.");

  const supabase = await createClient();
  // A function, not an insert: the workspace and the creator's admin membership
  // have to land together or a workspace exists that nobody can see (migration
  // 033 explains why at length).
  const { data, error } = await supabase.rpc("create_workspace", { workspace_name: clean });
  if (error) throw new Error(`Could not create the workspace: ${error.message}`);
  refresh();
  return data as string;
}

export async function renameWorkspace(name: string): Promise<void> {
  const workspaceId = await assertAdmin();
  const clean = name.trim();
  if (!clean) throw new Error("A workspace needs a name.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ name: clean })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  refresh();
}

export async function inviteMember(
  email: string,
  role: "admin" | "member" | "partner",
): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  const clean = email.trim().toLowerCase();
  // Deliberately loose: the address is a claim key, and the real check is that
  // someone signs in with it. Rejecting valid-but-unusual addresses would be
  // the worse error.
  if (!clean.includes("@") || clean.length < 3) throw new Error("That is not an email address.");

  const supabase = await createClient();
  const { error } = await supabase.from("workspace_invites").insert({
    workspace_id: workspaceId,
    email: clean,
    role,
    invited_by: user.id,
  });
  if (error) {
    // The partial unique index — one open invite per address per workspace.
    if (error.code === "23505") throw new Error(`${clean} already has an open invite.`);
    throw new Error(error.message);
  }
  refresh();
}

export async function withdrawInvite(inviteId: string): Promise<void> {
  await assertAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("workspace_invites").delete().eq("id", inviteId);
  if (error) throw new Error(error.message);
  refresh();
}

export async function changeMemberRole(
  userId: string,
  role: "admin" | "member" | "partner",
): Promise<void> {
  const workspaceId = await assertAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  // The database refuses to let the last admin be demoted; surface that in
  // words the operator can act on rather than the raw trigger message.
  if (error) throw new Error(friendlyAdminError(error.message));
  refresh();
}

export async function removeMember(userId: string): Promise<void> {
  const workspaceId = await assertAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(friendlyAdminError(error.message));
  refresh();
}

function friendlyAdminError(message: string): string {
  return /at least one admin/i.test(message)
    ? "That would leave the workspace with no admin. Promote someone else first."
    : message;
}

/**
 * Claim any invites addressed to the signed-in user's email.
 *
 * Safe to call on every request: it matches on the email in the caller's own
 * JWT, so it can only ever claim invites addressed to them, and it is a no-op
 * when there are none.
 */
export async function claimInvites(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_workspace_invites");
  if (error) return 0;
  const claimed = (data as number) ?? 0;
  if (claimed > 0) refresh();
  return claimed;
}

export type ProfileInput = {
  firmName?: string;
  senderName?: string;
  senderIntro?: string;
  approach?: string;
  vocab?: Partial<WorkspaceVocab>;
  copy?: Partial<DraftCopy>;
};

/**
 * Save the workspace's prompt identity and vocabulary.
 *
 * Anything left blank is STORED AS NULL, which means "use the built-in
 * default". That is what keeps a workspace that has customised nothing on the
 * defaults forever, rather than freezing today's defaults into its row — see
 * migration 032.
 */
export async function saveWorkspaceProfile(input: ProfileInput): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  const supabase = await createClient();

  const blankToNull = (v?: string) => {
    const t = (v ?? "").trim();
    return t ? t : null;
  };

  // Drop keys whose value equals the default: storing them would pin the value
  // at today's wording, so a later improvement to the default would not reach
  // this workspace even though nobody chose to override it.
  const prune = <T extends Record<string, string>>(
    given: Partial<T> | undefined,
    defaults: T,
  ): Record<string, string> | null => {
    if (!given) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(given)) {
      const value = (v ?? "").trim();
      if (value && value !== defaults[k as keyof T]) out[k] = value;
    }
    return Object.keys(out).length ? out : null;
  };

  const row = {
    workspace_id: workspaceId,
    firm_name:
      blankToNull(input.firmName) === DEFAULT_PROFILE.firmName ? null : blankToNull(input.firmName),
    sender_name:
      blankToNull(input.senderName) === DEFAULT_PROFILE.senderName
        ? null
        : blankToNull(input.senderName),
    sender_intro:
      blankToNull(input.senderIntro) === DEFAULT_PROFILE.senderIntro
        ? null
        : blankToNull(input.senderIntro),
    approach:
      blankToNull(input.approach) === DEFAULT_PROFILE.approach ? null : blankToNull(input.approach),
    vocab: prune(input.vocab, DEFAULT_PROFILE.vocab),
    copy: prune(input.copy, DEFAULT_PROFILE.copy as unknown as Record<string, string>),
    updated_at: new Date().toISOString(),
    updated_by: user.email ?? user.id,
  };

  const { error } = await supabase
    .from("workspace_profile")
    .upsert(row, { onConflict: "workspace_id" });
  if (error) throw new Error(error.message);
  refresh();
}

/** Reset every override, returning the workspace to the built-in defaults. */
export async function resetWorkspaceProfile(): Promise<void> {
  const workspaceId = await assertAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspace_profile")
    .delete()
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  refresh();
}

/** Members and open invites for the current workspace, for the Settings panel. */
export async function workspaceRoster(): Promise<{
  members: { userId: string; email: string | null; role: string; isYou: boolean }[];
  invites: { id: string; email: string; role: string; createdAt: string }[];
}> {
  const user = await requireUser();
  const workspaceId = await currentWorkspaceId();
  const supabase = await createClient();

  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", workspaceId),
    supabase
      .from("workspace_invites")
      .select("id, email, role, created_at")
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  // Emails come from a second query rather than an embed: workspace_members.
  // user_id points at auth.users, not profiles, so there is no foreign key for
  // PostgREST to traverse and `profiles(email)` would fail at runtime.
  const rows = (members ?? []) as unknown as { user_id: string; role: string }[];
  const emailById = new Map<string, string | null>();
  if (rows.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", rows.map((m) => m.user_id));
    (profiles ?? []).forEach((p) => emailById.set(p.id as string, (p.email as string) ?? null));
  }

  return {
    members: rows
      .map((m) => ({
        userId: m.user_id,
        email: emailById.get(m.user_id) ?? null,
        role: m.role,
        isYou: m.user_id === user.id,
      }))
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? "")),
    invites: ((invites ?? []) as unknown as {
      id: string;
      email: string;
      role: string;
      created_at: string;
    }[]).map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.created_at,
    })),
  };
}
