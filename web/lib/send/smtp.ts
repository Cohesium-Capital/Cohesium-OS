import "server-only";
import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { appendToSent } from "./imap";
import { emailIdentityReady, fromHeader, type EmailIdentity } from "./identity-env";

// Plain-text 1:1 sending. Text/plain + a real From keeps these personal and
// inbox-friendly.
//
// The identity is a REQUIRED parameter because a second workspace sends as
// itself, and a second PERSON in one workspace sends as themselves (migration
// 036). The operator's env identity is just one identity among others now —
// callers that want it say so (envEmailIdentity()), nothing defaults to it.

// Keyed by identity so two workspaces do not share one authenticated
// connection. A pool keyed only by "the process" was safe when there was one
// mailbox; it would now send one firm's mail down another's connection. The
// password rides in the key as a fingerprint so rotating a credential retires
// the stale authenticated connection instead of reusing it until the instance
// recycles.
const pool = new Map<string, Transporter>();

function transporter(identity: EmailIdentity): Transporter {
  const passPrint = createHash("sha256")
    .update(identity.smtpPass ?? "")
    .digest("hex")
    .slice(0, 12);
  const key = `${identity.smtpHost}|${identity.smtpPort}|${identity.smtpUser}|${passPrint}`;
  const existing = pool.get(key);
  if (existing) return existing;
  const created = nodemailer.createTransport({
    host: identity.smtpHost ?? undefined,
    port: identity.smtpPort,
    secure: identity.smtpPort === 465,
    auth: { user: identity.smtpUser ?? undefined, pass: identity.smtpPass ?? undefined },
  });
  pool.set(key, created);
  return created;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  identity: EmailIdentity;
}): Promise<{ ok: boolean; error?: string; messageId?: string; copiedToSent?: boolean }> {
  const identity = opts.identity;
  const missing = emailIdentityReady(identity);
  if (missing) {
    return {
      ok: false,
      error:
        identity.source === "env"
          ? `SMTP not configured (${missing}). Set SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM, or configure a sending identity in Settings.`
          : identity.source === "none"
            ? "No sending identity configured for this workspace — set one in Settings."
            : `The sending identity for this workspace is incomplete: ${missing}.`,
    };
  }
  const from = fromHeader(identity)!;
  const message = { from, to: opts.to, subject: opts.subject, text: opts.text, date: new Date() };
  // The transported Message-ID is what the recipient's reply will carry in
  // In-Reply-To — the caller stores it on the touch (provider_ref) so inbound
  // mail can be matched back to the exact outbound message.
  let messageId: string | undefined;
  try {
    const info = await transporter(identity).sendMail(message);
    messageId = info.messageId;
  } catch (e) {
    return { ok: false, error: `SMTP send failed: ${e instanceof Error ? e.message : e}` };
  }

  // Best-effort: drop a copy in the Sent folder of the mailbox THIS identity
  // sends from — never the env mailbox, which would file every tenant's
  // outbound mail (recipients and bodies) in the operator's webmail.
  // Reuse the transported Message-ID so the copy IS the message that went out.
  // A failure here never fails the send — the mail already went out.
  let copiedToSent = false;
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer({ ...message, messageId }).compile().build((err, msg) =>
        err ? reject(err) : resolve(msg),
      );
    });
    const res = await appendToSent(raw, {
      host: identity.imapHost,
      port: identity.imapPort,
      user: identity.imapUser,
      pass: identity.imapPass,
    });
    copiedToSent = res.ok;
  } catch {
    // ignore — Sent copy is non-critical
  }
  return { ok: true, messageId, copiedToSent };
}
