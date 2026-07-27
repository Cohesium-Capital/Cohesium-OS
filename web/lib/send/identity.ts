import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  envEmailIdentity,
  envLinkedinIdentity,
  type EmailIdentity,
  type LinkedinIdentity,
} from "./identity-env";
import {
  mergeEmailIdentity,
  mergeLinkedinIdentity,
  type IdentityRowLike,
  type IdentitySource,
} from "./identity-merge";

export {
  envEmailIdentity,
  envLinkedinIdentity,
  fromHeader,
  emailIdentityReady,
  emptyEmailIdentity,
  emptyLinkedinIdentity,
  type EmailIdentity,
  type LinkedinIdentity,
} from "./identity-env";

// Who a message goes out as.
//
// Before migration 036 this was a fixed set of environment variables. An
// identity is now a row, per workspace and optionally per user, and the env
// vars belong to exactly ONE workspace: the operator's (the oldest — resolve
// it with operatorWorkspaceId and pass it as `envWorkspaceId`). For the
// operator every lookup falls through to exactly the values sending used
// before this file existed; for every other workspace a missing identity means
// the send is HELD, never sent as the operator.
//
// Secrets come from sending_secret, which no browser session can read (RLS on,
// no policy). Called with a user's client these functions return the identity
// with the secret fields empty — and because the env fallback is gated on the
// operator workspace, a non-operator identity can never surface env
// credentials either. The merge rules live in identity-merge.ts, where they
// are tested.

const IDENTITY_COLUMNS =
  "id, user_id, from_name, from_email, smtp_host, smtp_port, smtp_user, imap_host, imap_port, imap_user, heyreach_account_id, heyreach_campaign_id";

async function identitySources(
  supabase: SupabaseClient,
  workspaceId: string,
  channel: "email" | "linkedin",
  userId?: string | null,
): Promise<{ personal: IdentitySource | null; shared: IdentitySource | null }> {
  // A PERSONAL identity follows its owner across workspaces (migration 043:
  // user_id set, workspace_id null); the SHARED identity belongs to the
  // workspace. Two point lookups, each against a unique index.
  const [{ data: personalRows }, { data: sharedRows }] = await Promise.all([
    userId
      ? supabase
          .from("sending_identity")
          .select(IDENTITY_COLUMNS)
          .eq("channel", channel)
          .eq("user_id", userId)
          .is("workspace_id", null)
          .limit(1)
      : Promise.resolve({ data: null }),
    supabase
      .from("sending_identity")
      .select(IDENTITY_COLUMNS)
      .eq("channel", channel)
      .eq("workspace_id", workspaceId)
      .is("user_id", null)
      .limit(1),
  ]);

  const withSecrets = async (row: IdentityRowLike | undefined): Promise<IdentitySource | null> =>
    row ? { row, secrets: await secretsFor(supabase, row.id) } : null;

  return {
    personal: await withSecrets((personalRows as unknown as IdentityRowLike[] | null)?.[0]),
    shared: await withSecrets((sharedRows as unknown as IdentityRowLike[] | null)?.[0]),
  };
}

async function secretsFor(
  supabase: SupabaseClient,
  identityId: string,
): Promise<{ smtp_pass: string | null; imap_pass: string | null; heyreach_api_key: string | null }> {
  // Returns nothing for a browser session — RLS denies the table outright —
  // which is the intended outcome, not an error to report.
  const { data } = await supabase
    .from("sending_secret")
    .select("smtp_pass, imap_pass, heyreach_api_key")
    .eq("identity_id", identityId)
    .maybeSingle();
  return {
    smtp_pass: (data?.smtp_pass as string | null) ?? null,
    imap_pass: (data?.imap_pass as string | null) ?? null,
    heyreach_api_key: (data?.heyreach_api_key as string | null) ?? null,
  };
}

/**
 * The email identity for a workspace, preferring a specific user's own mailbox.
 *
 * `envWorkspaceId` is the one workspace allowed to fall back to the
 * environment (resolve it with operatorWorkspaceId; pass null to forbid the
 * fallback outright). Every caller states it explicitly so the decision is
 * visible at the call site.
 */
export async function emailIdentityFor(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string | null | undefined,
  envWorkspaceId: string | null,
): Promise<EmailIdentity> {
  const { personal, shared } = await identitySources(supabase, workspaceId, "email", userId);
  const envAllowed = envWorkspaceId !== null && workspaceId === envWorkspaceId;
  return mergeEmailIdentity({ personal, shared, env: envAllowed ? envEmailIdentity() : null });
}

export async function linkedinIdentityFor(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string | null | undefined,
  envWorkspaceId: string | null,
): Promise<LinkedinIdentity> {
  const { personal, shared } = await identitySources(supabase, workspaceId, "linkedin", userId);
  const envAllowed = envWorkspaceId !== null && workspaceId === envWorkspaceId;
  return mergeLinkedinIdentity({ personal, shared, env: envAllowed ? envLinkedinIdentity() : null });
}
