import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceProfile } from "./identity";

// Per-user sender resolution.
//
// The drafted body's sign-off name and "who I am" intro belong to the PERSON
// sending, not the firm. workspace_profile (migration 032) holds the firm's
// admin-set default; this overlays the logged-in user on top of it:
//
//   sign-off name = member_sender override        (explicit, verbatim)
//                 → their sending-identity name    (first name)
//                 → their profile full_name        (first name)
//                 → workspace default              (left to the caller)
//   intro         = member_sender override
//                 → workspace default              (left to the caller)
//
// Returning only the keys we can fill means the caller keeps its default for
// anything unresolved — so this never regresses a workspace with no per-user
// data (e.g. Cohesium) below its previous behaviour.

export type SenderSources = {
  /** the user's own member_sender row for this workspace, if any */
  override: {
    sender_name: string | null;
    sender_intro: string | null;
    approach: string | null;
  } | null;
  /** from_name on the user's personal email sending_identity (migration 043) */
  identityFromName: string | null;
  /** profiles.full_name for the user (migration 003) */
  fullName: string | null;
};

export type SenderOverride = {
  senderName?: string;
  senderIntro?: string;
  approach?: string;
};

const trimmed = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

// A natural sign-off is a first name: "Saagar Kulkarni" -> "Saagar". Applied to
// DERIVED names only (identity/profile). An explicit override is used verbatim —
// if someone signs "Saagar K.", that is their choice to keep.
const firstName = (v: string | null | undefined): string | undefined => {
  const t = trimmed(v);
  return t ? t.split(/\s+/)[0] : undefined;
};

export function pickSenderOverrides(s: SenderSources): SenderOverride {
  const senderName =
    trimmed(s.override?.sender_name) ??
    firstName(s.identityFromName) ??
    firstName(s.fullName);
  const senderIntro = trimmed(s.override?.sender_intro);
  // Intro and approach are prose: an override supplies them or the caller keeps
  // the workspace default. Only the NAME derives from other user sources.
  const approach = trimmed(s.override?.approach);

  const out: SenderOverride = {};
  if (senderName) out.senderName = senderName;
  if (senderIntro) out.senderIntro = senderIntro;
  if (approach) out.approach = approach;
  return out;
}

/** Overlay resolved per-user sender fields onto a workspace profile. */
export function applySenderOverrides(
  p: WorkspaceProfile,
  o: SenderOverride,
): WorkspaceProfile {
  if (!o.senderName && !o.senderIntro && !o.approach) return p;
  return {
    ...p,
    ...(o.senderName ? { senderName: o.senderName } : {}),
    ...(o.senderIntro ? { senderIntro: o.senderIntro } : {}),
    ...(o.approach ? { approach: o.approach } : {}),
  };
}

/**
 * Resolve the logged-in user's sender overrides. Never throws — like
 * workspaceProfile, a prompt must remain buildable if these reads fail, in
 * which case the caller keeps the workspace default.
 */
export async function senderOverridesFor(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string | null | undefined,
): Promise<SenderOverride> {
  if (!userId) return {};
  try {
    const [{ data: override }, { data: identity }, { data: profile }] =
      await Promise.all([
        supabase
          .from("member_sender")
          .select("sender_name, sender_intro, approach")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle(),
        supabase
          .from("sending_identity")
          .select("from_name")
          .eq("channel", "email")
          .eq("user_id", userId)
          .is("workspace_id", null)
          .maybeSingle(),
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", userId)
          .maybeSingle(),
      ]);
    return pickSenderOverrides({
      override: (override as SenderSources["override"]) ?? null,
      identityFromName: (identity?.from_name as string | null) ?? null,
      fullName: (profile?.full_name as string | null) ?? null,
    });
  } catch {
    return {};
  }
}
