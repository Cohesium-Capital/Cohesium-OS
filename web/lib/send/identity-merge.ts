// How a sending identity is assembled from its possible sources, as pure
// functions so the fallback matrix is testable (identity.ts carries the
// "server-only" guard and the database reads; this file must not).
//
// THE RULES, in order:
//
// 1. A person's own row wins over the workspace's shared row, field by field —
//    someone who sets only their From address still rides the firm's mail host.
// 2. The environment is a source ONLY for the operator's workspace (the caller
//    decides by passing `env: null` for everyone else). Before tenancy the env
//    was the only identity; it remains exactly that for the workspace it
//    belongs to, and nothing for anyone else.
// 3. Credentials travel in pairs. A username and its password must come from
//    the same source: a row that names its own smtp_user never borrows a
//    password set for a different account, even when that leaves it incomplete.
//    Incomplete is recoverable (the send is held and says why); mixed
//    credentials would either fail confusingly or authenticate as the wrong
//    mailbox.

import {
  emptyEmailIdentity,
  emptyLinkedinIdentity,
  type EmailIdentity,
  type LinkedinIdentity,
} from "./identity-env";

export type IdentityRowLike = {
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

export type SecretsLike = {
  smtp_pass: string | null;
  imap_pass: string | null;
  heyreach_api_key: string | null;
};

export type IdentitySource = { row: IdentityRowLike; secrets: SecretsLike };

type CredPair = { user: string | null; pass: string | null };

// First source that names a user supplies BOTH halves (rule 3).
function credPair(sources: CredPair[]): CredPair {
  for (const s of sources) if (s.user) return { user: s.user, pass: s.pass };
  return { user: null, pass: null };
}

export function mergeEmailIdentity(args: {
  /** The requesting user's own row, when they have one. */
  personal: IdentitySource | null;
  /** The workspace's shared row (user_id null). */
  shared: IdentitySource | null;
  /** The environment identity, or null when this workspace may not use it. */
  env: EmailIdentity | null;
}): EmailIdentity {
  const { personal, shared } = args;
  const primary = personal ?? shared;
  if (!primary) return args.env ?? emptyEmailIdentity();

  const env = args.env ?? emptyEmailIdentity();
  const chain = [personal, shared].filter((s): s is IdentitySource => s !== null);
  const pick = <T>(get: (s: IdentitySource) => T | null): T | null => {
    for (const s of chain) {
      const v = get(s);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };

  const smtp = credPair([
    ...chain.map((s) => ({ user: s.row.smtp_user, pass: s.secrets.smtp_pass })),
    { user: env.smtpUser, pass: env.smtpPass },
  ]);
  const imap = credPair([
    ...chain.map((s) => ({ user: s.row.imap_user, pass: s.secrets.imap_pass })),
    { user: env.imapUser, pass: env.imapPass },
  ]);

  return {
    identityId: primary.row.id,
    fromName: pick((s) => s.row.from_name) ?? env.fromName,
    fromEmail: pick((s) => s.row.from_email) ?? env.fromEmail,
    smtpHost: pick((s) => s.row.smtp_host) ?? env.smtpHost,
    smtpPort: pick((s) => s.row.smtp_port) ?? env.smtpPort,
    smtpUser: smtp.user,
    smtpPass: smtp.pass,
    imapHost: pick((s) => s.row.imap_host) ?? env.imapHost,
    imapPort: pick((s) => s.row.imap_port) ?? env.imapPort,
    imapUser: imap.user,
    imapPass: imap.pass,
    source: primary.row.user_id ? "user" : "workspace",
  };
}

export function mergeLinkedinIdentity(args: {
  personal: IdentitySource | null;
  shared: IdentitySource | null;
  env: LinkedinIdentity | null;
}): LinkedinIdentity {
  const { personal, shared } = args;
  const primary = personal ?? shared;
  if (!primary) return args.env ?? emptyLinkedinIdentity();

  const env = args.env ?? emptyLinkedinIdentity();
  const chain = [personal, shared].filter((s): s is IdentitySource => s !== null);
  const pick = <T>(get: (s: IdentitySource) => T | null): T | null => {
    for (const s of chain) {
      const v = get(s);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };

  return {
    identityId: primary.row.id,
    // The ACCOUNT never falls back past the primary row — pushing leads out of
    // someone else's LinkedIn account is the exact mistake this table prevents.
    accountId: primary.row.heyreach_account_id,
    // The campaign is usually per firm rather than per person: personal row →
    // the workspace's shared row → env (operator only).
    campaignId: pick((s) => s.row.heyreach_campaign_id) ?? env.campaignId,
    apiKey: pick((s) => s.secrets.heyreach_api_key) ?? env.apiKey,
    source: primary.row.user_id ? "user" : "workspace",
  };
}
