import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { appendToSent } from "./imap";
import {
  envEmailIdentity,
  emailIdentityReady,
  fromHeader,
  type EmailIdentity,
} from "./identity-env";

// Plain-text 1:1 sending. Text/plain + a real From keeps these personal and
// inbox-friendly.
//
// The identity is a parameter rather than a module-level constant because a
// second workspace sends as itself, and a second PERSON in one workspace sends
// as themselves (migration 036). Callers that pass nothing get the environment
// identity, which is what every send used before and what Cohesium still uses.

// Keyed by identity so two workspaces do not share one authenticated
// connection. A pool keyed only by "the process" was safe when there was one
// mailbox; it would now send one firm's mail down another's connection.
const pool = new Map<string, Transporter>();

function transporter(identity: EmailIdentity): Transporter {
  const key = `${identity.smtpHost}|${identity.smtpPort}|${identity.smtpUser}`;
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
  identity?: EmailIdentity;
}): Promise<{ ok: boolean; error?: string; messageId?: string; copiedToSent?: boolean }> {
  const identity = opts.identity ?? envEmailIdentity();
  const missing = emailIdentityReady(identity);
  if (missing) {
    return {
      ok: false,
      error:
        identity.source === "env"
          ? `SMTP not configured (${missing}). Set SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM, or configure a sending identity in Settings.`
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

  // Best-effort: drop a copy in the IMAP Sent folder so it shows in webmail.
  // Reuse the transported Message-ID so the copy IS the message that went out.
  // A failure here never fails the send — the mail already went out.
  let copiedToSent = false;
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer({ ...message, messageId }).compile().build((err, msg) =>
        err ? reject(err) : resolve(msg),
      );
    });
    const res = await appendToSent(raw);
    copiedToSent = res.ok;
  } catch {
    // ignore — Sent copy is non-critical
  }
  return { ok: true, messageId, copiedToSent };
}
