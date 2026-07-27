import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  envEmailIdentity,
  envLinkedinIdentity,
  type EmailIdentity,
  type LinkedinIdentity,
} from "./identity-env";

export {
  envEmailIdentity,
  envLinkedinIdentity,
  fromHeader,
  emailIdentityReady,
  type EmailIdentity,
  type LinkedinIdentity,
} from "./identity-env";

// Who a message goes out as.
//
// Before migration 036 this was a fixed set of environment variables, which is
// why the cron had to refuse to run once a second workspace existed: it had one
// mailbox and no way to know whose mail it was sending. An identity is now a
// row, per workspace and optionally per user.
//
// The env vars remain the LAST RESORT, and that is what keeps Cohesium working
// untouched: it has configured nothing, so every lookup here falls through to
// exactly the values the sender used before this file existed.
//
// Secrets come from sending_secret, which no browser session can read (RLS on,
// no policy). That means these functions only return credentials when called
// with a service-role client — the cron. Called with a user's client they still
// return the identity, with the secret fields empty, which is precisely what a
// Settings page should see.

type IdentityRow = {
  id: string;
  user_id: string | null;
  from_name: string | null;
  from_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_user: string | null;
  heyreach_account_id: string | null;
  heyreach_campaign_id: string | null;
};

// The user's own identity wins over the workspace's shared one. Ordering by
// user_id with nulls last does the picking: a row for this specific person
// sorts before the shared row.
async function pickIdentity(
  supabase: SupabaseClient,
  workspaceId: string,
  channel: "email" | "linkedin",
  userId?: string | null,
): Promise<IdentityRow | null> {
  let query = supabase
    .from("sending_identity")
    .select(
      "id, user_id, from_name, from_email, smtp_host, smtp_port, smtp_user, imap_host, imap_port, imap_user, heyreach_account_id, heyreach_campaign_id",
    )
    .eq("workspace_id", workspaceId)
    .eq("channel", channel);
  query = userId ? query.or(`user_id.eq.${userId},user_id.is.null`) : query.is("user_id", null);

  const { data } = await query;
  const rows = (data ?? []) as unknown as IdentityRow[];
  if (!rows.length) return null;
  return rows.find((r) => r.user_id === userId) ?? rows.find((r) => r.user_id === null) ?? null;
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
 * Falls back to the environment when the workspace has configured nothing —
 * which is every workspace today, and is why this change is invisible to
 * Cohesium.
 */
export async function emailIdentityFor(
  supabase: SupabaseClient,
  workspaceId: string,
  userId?: string | null,
): Promise<EmailIdentity> {
  const row = await pickIdentity(supabase, workspaceId, "email", userId);
  if (!row) return envEmailIdentity();

  const secrets = await secretsFor(supabase, row.id);
  const env = envEmailIdentity();
  return {
    identityId: row.id,
    fromName: row.from_name,
    fromEmail: row.from_email,
    // Host and port fall back individually: a workspace that sets only a From
    // address on the shared mail host should not have to restate the host.
    smtpHost: row.smtp_host ?? env.smtpHost,
    smtpPort: row.smtp_port ?? env.smtpPort,
    smtpUser: row.smtp_user ?? env.smtpUser,
    smtpPass: secrets.smtp_pass ?? (row.smtp_user ? null : env.smtpPass),
    imapHost: row.imap_host ?? env.imapHost,
    imapPort: row.imap_port ?? env.imapPort,
    imapUser: row.imap_user ?? env.imapUser,
    imapPass: secrets.imap_pass ?? (row.imap_user ? null : env.imapPass),
    source: row.user_id ? "user" : "workspace",
  };
}

export async function linkedinIdentityFor(
  supabase: SupabaseClient,
  workspaceId: string,
  userId?: string | null,
): Promise<LinkedinIdentity> {
  const row = await pickIdentity(supabase, workspaceId, "linkedin", userId);
  if (!row) return envLinkedinIdentity();

  const secrets = await secretsFor(supabase, row.id);
  const env = envLinkedinIdentity();
  return {
    identityId: row.id,
    accountId: row.heyreach_account_id,
    // The campaign is usually per firm rather than per person, so it falls back
    // to the shared value; the ACCOUNT never does — sending from the wrong
    // LinkedIn account is exactly the mistake this table exists to prevent.
    campaignId: row.heyreach_campaign_id ?? env.campaignId,
    apiKey: secrets.heyreach_api_key ?? env.apiKey,
    source: row.user_id ? "user" : "workspace",
  };
}
