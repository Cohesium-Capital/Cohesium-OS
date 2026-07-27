// The shape of a sending identity, and the environment-variable one.
//
// Split from identity.ts so it can be tested: identity.ts carries the
// "server-only" guard (it reads the database and credentials), which the test
// runner cannot resolve. Nothing here touches the database or the network — it
// is types, env parsing, and two predicates.

export type EmailIdentity = {
  identityId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPass: string | null;
  imapHost: string | null;
  imapPort: number;
  imapUser: string | null;
  imapPass: string | null;
  /** Where this came from, for diagnostics that would otherwise be guesswork. */
  source: "user" | "workspace" | "env" | "none";
};

export type LinkedinIdentity = {
  identityId: string | null;
  accountId: string | null;
  campaignId: string | null;
  apiKey: string | null;
  source: "user" | "workspace" | "env" | "none";
};

/** The environment-variable identity — what every send used before 036. */
export function envEmailIdentity(): EmailIdentity {
  const from = process.env.MAIL_FROM ?? "";
  // MAIL_FROM is "Name <address@host>" or a bare address.
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return {
    identityId: null,
    fromName: match ? match[1] || null : null,
    fromEmail: match ? match[2] : from || null,
    smtpHost: process.env.SMTP_HOST ?? null,
    smtpPort: Number(process.env.SMTP_PORT ?? 465),
    smtpUser: process.env.SMTP_USER ?? null,
    smtpPass: process.env.SMTP_PASS ?? null,
    imapHost: process.env.IMAP_HOST ?? null,
    imapPort: Number(process.env.IMAP_PORT ?? 993),
    imapUser: process.env.IMAP_USER ?? null,
    imapPass: process.env.IMAP_PASS ?? null,
    source: "env",
  };
}

export function envLinkedinIdentity(): LinkedinIdentity {
  return {
    identityId: null,
    accountId: process.env.HEYREACH_ACCOUNT_ID ?? null,
    campaignId: process.env.HEYREACH_CAMPAIGN_ID ?? null,
    apiKey: process.env.HEYREACH_API_KEY ?? null,
    source: "env",
  };
}

// "Nothing configured" identities: what a workspace that is not the operator's
// resolves to when it has no identity rows. Deliberately incomplete — the
// readiness checks then hold its sends rather than borrowing the operator's
// credentials from the environment.

export function emptyEmailIdentity(): EmailIdentity {
  return {
    identityId: null,
    fromName: null,
    fromEmail: null,
    smtpHost: null,
    smtpPort: 465,
    smtpUser: null,
    smtpPass: null,
    imapHost: null,
    imapPort: 993,
    imapUser: null,
    imapPass: null,
    source: "none",
  };
}

export function emptyLinkedinIdentity(): LinkedinIdentity {
  return { identityId: null, accountId: null, campaignId: null, apiKey: null, source: "none" };
}

/** Rebuild the "Name <address>" header a transport wants. */
export function fromHeader(identity: EmailIdentity): string | null {
  if (!identity.fromEmail) return null;
  return identity.fromName ? `${identity.fromName} <${identity.fromEmail}>` : identity.fromEmail;
}

/** Is this identity complete enough to actually send with? */
export function emailIdentityReady(i: EmailIdentity): string | null {
  if (!i.smtpHost) return "no SMTP host";
  if (!i.smtpUser) return "no SMTP user";
  if (!i.smtpPass) return "no SMTP password";
  if (!fromHeader(i)) return "no From address";
  return null;
}
