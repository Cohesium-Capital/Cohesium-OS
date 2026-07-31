"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { currentWorkspace, currentWorkspaceId } from "./context";
import { DEFAULT_COPY, DEFAULT_PROFILE, type WorkspaceVocab } from "./identity";
import { workspaceProfile } from "./profile";
import {
  buildExamples,
  permittedSource,
  type ExampleAnswers,
} from "@/lib/drafting/example-builder";
import { smoothExample } from "@/lib/drafting/example-smooth";

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
  // 'partner' is deliberately not offered: 028 replaced the old role-checking
  // policies with membership-only checks, which silently promoted partner from
  // no-access to full member access. Until partner-specific policies exist,
  // inviting one would grant full read/write under a label that promises less.
  role: "admin" | "member",
): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  if (role !== "admin" && role !== "member") throw new Error("Unknown role.");
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
  // Same rule as inviteMember: no new partners until the role has policies.
  role: "admin" | "member",
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
 *
 * Deliberately does NOT revalidate. This is called during the Settings page
 * render, and revalidatePath is documented for Server Functions and Route
 * Handlers — not render. It needs no revalidation anyway: the render that
 * follows reads the membership it just created.
 */
export async function claimInvites(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_workspace_invites");
  if (error) {
    // Returning 0 quietly makes a BROKEN claim indistinguishable from "no
    // invite was waiting" — the caller renders request-access either way, and
    // the invitee is told they have no workspace while their seat sits unclaimed.
    // The call still resolves rather than throwing: a failed claim must not
    // take down the shell for a user who already has a workspace.
    console.error("[claimInvites] claim_workspace_invites failed:", error.message);
    return 0;
  }
  return (data as number) ?? 0;
}

export type ProfileInput = {
  firmName?: string;
  // senderName is deliberately NOT here: the sign-off name is per user
  // (member_sender / their profile), not a firm-wide default an admin sets. The
  // workspace_profile.sender_name column still exists as a hidden last-resort
  // fallback and is preserved by this upsert (it only writes the columns it
  // names), but there is no admin path to it anymore.
  senderIntro?: string;
  approach?: string;
  vocab?: Partial<WorkspaceVocab>;
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
    // sender_name is deliberately ABSENT (like `copy` below): the sign-off name
    // is per user now, so the firm form must not write it. The upsert only
    // writes the columns it names, so the stored last-resort value is preserved.
    sender_intro:
      blankToNull(input.senderIntro) === DEFAULT_PROFILE.senderIntro
        ? null
        : blankToNull(input.senderIntro),
    approach:
      blankToNull(input.approach) === DEFAULT_PROFILE.approach ? null : blankToNull(input.approach),
    vocab: prune(input.vocab, DEFAULT_PROFILE.vocab),
    // `copy` (the worked examples) is deliberately ABSENT: it belongs to
    // saveWorkedExamples alone. An upsert only writes the columns it names, so
    // omitting it preserves whatever is stored — the identity form used to
    // carry it as undefined, which nulled a workspace's curated examples
    // (including Cohesium's migration-039 seed) on every firm-name save.
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

// ---------------------------------------------------------------------------
// sending identities (migration 036)
// ---------------------------------------------------------------------------

export type SendingIdentityRow = {
  id: string;
  userId: string | null;
  channel: "email" | "linkedin";
  label: string | null;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapUser: string | null;
  heyreachAccountId: string | null;
  heyreachCampaignId: string | null;
  hasSmtpPass: boolean;
  hasImapPass: boolean;
  hasHeyreachKey: boolean;
};

/**
 * Sending identities to show in Settings: the current workspace's SHARED rows
 * plus every PERSONAL row the caller can see (their own, and co-members' —
 * personal rows are global since 043 and follow their owner).
 *
 * Credentials themselves are never read here — sending_secret is unreadable to
 * any browser session. `sending_secret_status` answers only whether each one is
 * set, which is what the UI needs and all it should get.
 */
export async function sendingIdentities(): Promise<SendingIdentityRow[]> {
  await requireUser();
  const workspaceId = await currentWorkspaceId();
  const supabase = await createClient();

  const [{ data: shared }, { data: personal }] = await Promise.all([
    supabase
      .from("sending_identity")
      .select("*")
      .eq("workspace_id", workspaceId)
      .is("user_id", null)
      .order("channel"),
    supabase
      .from("sending_identity")
      .select("*")
      .is("workspace_id", null)
      .not("user_id", "is", null)
      .order("channel"),
  ]);

  const rows = [...(shared ?? []), ...(personal ?? [])] as unknown as Record<string, unknown>[];
  return Promise.all(
    rows.map(async (r) => {
      const { data: status } = await supabase.rpc("sending_secret_status", {
        p_identity_id: r.id as string,
      });
      const s = (status ?? [])[0] as
        | { has_smtp_pass: boolean; has_imap_pass: boolean; has_heyreach_key: boolean }
        | undefined;
      return {
        id: r.id as string,
        userId: (r.user_id as string | null) ?? null,
        channel: r.channel as "email" | "linkedin",
        label: (r.label as string | null) ?? null,
        fromName: (r.from_name as string | null) ?? null,
        fromEmail: (r.from_email as string | null) ?? null,
        smtpHost: (r.smtp_host as string | null) ?? null,
        smtpPort: (r.smtp_port as number | null) ?? null,
        smtpUser: (r.smtp_user as string | null) ?? null,
        imapHost: (r.imap_host as string | null) ?? null,
        imapPort: (r.imap_port as number | null) ?? null,
        imapUser: (r.imap_user as string | null) ?? null,
        heyreachAccountId: (r.heyreach_account_id as string | null) ?? null,
        heyreachCampaignId: (r.heyreach_campaign_id as string | null) ?? null,
        hasSmtpPass: s?.has_smtp_pass ?? false,
        hasImapPass: s?.has_imap_pass ?? false,
        hasHeyreachKey: s?.has_heyreach_key ?? false,
      };
    }),
  );
}

export type SendingIdentityInput = {
  id?: string;
  channel: "email" | "linkedin";
  /** null = the workspace's shared identity; a user id = that person's own. */
  userId?: string | null;
  label?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  imapUser?: string | null;
  heyreachAccountId?: string | null;
  heyreachCampaignId?: string | null;
  /** Write-only. Omitted or blank leaves whatever is stored untouched. */
  smtpPass?: string;
  imapPass?: string;
  heyreachApiKey?: string;
};

/**
 * Save a sending identity.
 *
 * Two ownership modes since migration 043:
 * - PERSONAL (input.userId === the caller): the caller's own row, global — it
 *   follows them across workspaces. Any member may manage their own; nobody
 *   may manage someone else's (their mailbox, their credentials).
 * - SHARED (input.userId null): the current workspace's firm identity,
 *   admin-only, as before.
 */
export async function saveSendingIdentity(input: SendingIdentityInput): Promise<string> {
  const user = await requireUser();
  const personal = input.userId != null;
  if (personal && input.userId !== user.id) {
    throw new Error("A personal sending identity can only be managed by its owner.");
  }
  const workspaceId = personal ? null : await assertAdmin();
  const supabase = await createClient();

  const nn = (v?: string | null) => {
    const t = (v ?? "").toString().trim();
    return t ? t : null;
  };

  const row = {
    from_name: nn(input.fromName),
    from_email: nn(input.fromEmail),
    smtp_host: nn(input.smtpHost),
    smtp_port: input.smtpPort ?? null,
    smtp_user: nn(input.smtpUser),
    imap_host: nn(input.imapHost),
    imap_port: input.imapPort ?? null,
    imap_user: nn(input.imapUser),
    heyreach_account_id: nn(input.heyreachAccountId),
    // The campaign is firm-level and resolution ignores it on personal rows
    // (a traveling personal row must not carry one firm's campaign into
    // another) — don't store dead values there either.
    heyreach_campaign_id: personal ? null : nn(input.heyreachCampaignId),
    // Only set when the form actually carried it — the edit form has no label
    // field, and an unconditional write would null a label on every edit.
    ...(input.label !== undefined ? { label: nn(input.label) } : {}),
    updated_at: new Date().toISOString(),
    updated_by: user.email ?? user.id,
  };

  let identityId = input.id;
  if (identityId) {
    // The update names neither workspace_id nor user_id/channel: identity
    // rows never migrate between workspaces or owners. The ownership filter
    // (not just RLS, which spans everything the caller can see) guarantees a
    // stale tab cannot re-home a row — and its secrets — to whatever is now
    // on screen.
    let update = supabase.from("sending_identity").update(row).eq("id", identityId);
    update = personal ? update.eq("user_id", user.id) : update.eq("workspace_id", workspaceId!);
    const { data: updated, error } = await update.select("id");
    if (error) throw new Error(error.message);
    if (!updated?.length) {
      throw new Error(
        personal
          ? "That identity is not yours to edit."
          : "That identity does not belong to the current workspace.",
      );
    }
  } else {
    const { data, error } = await supabase
      .from("sending_identity")
      .insert({
        ...row,
        // Exactly one owner (043): a personal row carries no workspace, a
        // shared row no user.
        workspace_id: personal ? null : workspaceId,
        user_id: personal ? user.id : null,
        channel: input.channel,
        label: nn(input.label),
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        throw new Error(
          personal
            ? "You already have an identity for that channel — edit it instead."
            : "This workspace already has a shared identity for that channel.",
        );
      }
      throw new Error(error.message);
    }
    identityId = data.id as string;
  }

  // Credentials go through the definer function, and only when actually
  // supplied: a blank field means "leave it alone", so saving the From address
  // does not wipe a password the form never displayed. The HeyReach org key is
  // firm-level like the campaign — never stored on a personal row.
  const smtpPass = nn(input.smtpPass);
  const imapPass = nn(input.imapPass);
  const heyreachKey = personal ? null : nn(input.heyreachApiKey);
  if (smtpPass || imapPass || heyreachKey) {
    const { error } = await supabase.rpc("set_sending_secret", {
      p_identity_id: identityId,
      p_smtp_pass: smtpPass,
      p_imap_pass: imapPass,
      p_heyreach_api_key: heyreachKey,
    });
    if (error) throw new Error(`Saved the identity but not the credentials: ${error.message}`);
  }

  refresh();
  return identityId!;
}

export async function deleteSendingIdentity(id: string): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("sending_identity")
    .select("id, user_id, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) throw new Error("No such sending identity.");

  // Owner deletes their own personal identity; admins delete the workspace's
  // shared one. The filters mirror the RLS policies so a failure is a clear
  // error instead of a silent zero-row delete.
  let del = supabase.from("sending_identity").delete().eq("id", id);
  if (existing.user_id) {
    if (existing.user_id !== user.id) {
      throw new Error("A personal sending identity can only be removed by its owner.");
    }
    del = del.eq("user_id", user.id);
  } else {
    const workspaceId = await assertAdmin();
    del = del.eq("workspace_id", workspaceId);
  }
  // The secret cascades with the identity.
  const { error } = await del;
  if (error) throw new Error(error.message);
  refresh();
}

// ---------------------------------------------------------------------------
// worked examples (the drafting prompt's gold block)
// ---------------------------------------------------------------------------

/**
 * Turn interview answers into a pair of worked examples.
 *
 * Two steps with a hard line between them. buildExamples is deterministic and
 * offline — it slots the operator's own words into the skeleton, and it alone
 * decides the substance. The model afterwards may only tighten the prose, and
 * whatever it returns is checked for smuggled-in specifics before being
 * accepted; a rewrite that adds anything is discarded in favour of the plain
 * version. Nothing here saves: the operator sees the result and chooses.
 */
export async function draftExamplesFromInterview(answers: ExampleAnswers): Promise<{
  goldCustomer: string;
  goldMsp: string;
  notes: string[];
}> {
  await assertAdmin();
  const workspaceId = await currentWorkspaceId();
  const supabase = await createClient();
  const profile = await workspaceProfile(supabase, workspaceId);

  const built = buildExamples(answers);
  const permitted = permittedSource(answers, profile);

  const [customer, msp] = await Promise.all([
    smoothExample(built.goldCustomer, permitted),
    smoothExample(built.goldMsp, permitted),
  ]);

  const notes: string[] = [];
  for (const [label, r] of [["Customer", customer], ["Operator", msp]] as const) {
    if (r.note) notes.push(`${label}: ${r.note}`);
  }
  if (customer.smoothed && msp.smoothed) {
    notes.push("Prose tightened by the model; every specific is still yours.");
  }

  return { goldCustomer: customer.text, goldMsp: msp.text, notes };
}

/** Save the examples exactly as shown, after any hand-editing. */
export async function saveWorkedExamples(input: {
  goldCustomer: string;
  goldMsp: string;
}): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  const supabase = await createClient();

  const customer = input.goldCustomer.trim();
  const msp = input.goldMsp.trim();
  if (!customer || !msp) throw new Error("Both examples need text.");

  // Merge into whatever copy already exists rather than replacing it: persona
  // angles and subject shapes live in the same column and are not edited here.
  const { data: existing } = await supabase
    .from("workspace_profile")
    .select("copy")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  const copy = {
    ...((existing?.copy as Record<string, string> | null) ?? {}),
    goldCustomer: customer,
    goldMsp: msp,
  };

  const { error } = await supabase.from("workspace_profile").upsert(
    {
      workspace_id: workspaceId,
      copy,
      updated_at: new Date().toISOString(),
      updated_by: user.email ?? user.id,
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  refresh();
}

/** The examples currently in force, defaults included, for the editor. */
export async function currentWorkedExamples(): Promise<{
  goldCustomer: string;
  goldMsp: string;
  isDefault: boolean;
}> {
  await requireUser();
  const workspaceId = await currentWorkspaceId();
  const supabase = await createClient();
  const profile = await workspaceProfile(supabase, workspaceId);
  const { data } = await supabase
    .from("workspace_profile")
    .select("copy")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const stored = (data?.copy as Record<string, string> | null) ?? null;
  return {
    goldCustomer: profile.copy.goldCustomer,
    goldMsp: profile.copy.goldMsp,
    isDefault: !stored?.goldCustomer,
  };
}

/**
 * The framing blocks: the prose around the worked examples that tells the model
 * WHO it is writing to and what a subject line should look like.
 *
 * Editable here rather than only by migration because they are market-specific
 * in a way vocabulary substitution cannot reach — "where a TPA takes the
 * compliance work off their plate" is a sentence about one industry, not a word
 * that can be swapped. A tenant whose angles are wrong has no other way to fix
 * them, and wrong angles are worse than generic ones: they make confident,
 * fluent claims about the recipient's job that happen not to be true.
 *
 * `approachInline` and `approachBullet` stay out of this deliberately. They are
 * wrapped renderings of `approach`, which the identity panel already edits, and
 * their LINE BREAKS are part of the prompt hash — editing them in a textarea
 * would fork prompt_versions on invisible whitespace.
 */
const FRAMING_KEYS = [
  "personaAnglesCustomer",
  "personaAnglesMsp",
  "subjectShapesCustomer",
  "subjectShapesMsp",
  "perspectiveCustomer",
  "perspectiveMsp",
] as const;

export type FramingKey = (typeof FRAMING_KEYS)[number];
export type FramingCopy = Record<FramingKey, string>;

/** The effective blocks (a workspace's own, or the built-in defaults). */
export async function currentFramingCopy(): Promise<{
  copy: FramingCopy;
  defaults: FramingCopy;
  overridden: FramingKey[];
}> {
  await requireUser();
  const workspaceId = await currentWorkspaceId();
  const supabase = await createClient();
  const profile = await workspaceProfile(supabase, workspaceId);
  const { data } = await supabase
    .from("workspace_profile")
    .select("copy")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const stored = (data?.copy as Record<string, string> | null) ?? null;

  const copy = {} as FramingCopy;
  const defaults = {} as FramingCopy;
  const overridden: FramingKey[] = [];
  for (const key of FRAMING_KEYS) {
    copy[key] = profile.copy[key];
    defaults[key] = DEFAULT_COPY[key];
    // Which fields this workspace has actually changed — so the UI can say
    // "yours" rather than presenting an inherited default as a decision made.
    if (stored?.[key]) overridden.push(key);
  }
  return { copy, defaults, overridden };
}

/** Save the framing blocks, merging into whatever else `copy` holds. */
export async function saveFramingCopy(input: Partial<FramingCopy>): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  const supabase = await createClient();

  const next: Record<string, string> = {};
  for (const key of FRAMING_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    // An empty block would delete a section of the prompt rather than reset it,
    // and the result reads as a prompt someone forgot to finish. Reset is a
    // separate, explicit action.
    if (!trimmed) throw new Error("A framing block cannot be empty — use Reset to restore the default.");
    next[key] = trimmed;
  }
  if (!Object.keys(next).length) return;

  // Same merge discipline as saveWorkedExamples: `copy` is one jsonb column
  // shared with the gold examples, and an upsert that names only these keys
  // would drop the rest.
  const { data: existing } = await supabase
    .from("workspace_profile")
    .select("copy")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  const { error } = await supabase.from("workspace_profile").upsert(
    {
      workspace_id: workspaceId,
      copy: { ...((existing?.copy as Record<string, string> | null) ?? {}), ...next },
      updated_at: new Date().toISOString(),
      updated_by: user.email ?? user.id,
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  refresh();
}

/** Drop this workspace's override for one block, restoring the built-in text. */
export async function resetFramingBlock(key: FramingKey): Promise<void> {
  const workspaceId = await assertAdmin();
  const user = await requireUser();
  const supabase = await createClient();
  if (!FRAMING_KEYS.includes(key)) throw new Error(`Not a framing block: ${key}`);

  const { data: existing } = await supabase
    .from("workspace_profile")
    .select("copy")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const copy = { ...((existing?.copy as Record<string, string> | null) ?? {}) };
  delete copy[key];

  const { error } = await supabase.from("workspace_profile").upsert(
    {
      workspace_id: workspaceId,
      copy,
      updated_at: new Date().toISOString(),
      updated_by: user.email ?? user.id,
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  refresh();
}
