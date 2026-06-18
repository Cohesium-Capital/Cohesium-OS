import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { appendToSent } from "./imap";

// Plain-text 1:1 sending from the outreach domain (cohesium.co via Hostinger).
// Text/plain + a real From keeps these personal and inbox-friendly.

let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  const port = Number(process.env.SMTP_PORT ?? 465);
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return cached;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: boolean; error?: string; copiedToSent?: boolean }> {
  const from = process.env.MAIL_FROM; // e.g. "Ripley <ripley@cohesium.co>"
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !from) {
    return { ok: false, error: "SMTP not configured (SMTP_HOST / SMTP_USER / MAIL_FROM)." };
  }
  const message = { from, to: opts.to, subject: opts.subject, text: opts.text, date: new Date() };
  try {
    await transporter().sendMail(message);
  } catch (e) {
    return { ok: false, error: `SMTP send failed: ${e instanceof Error ? e.message : e}` };
  }

  // Best-effort: drop a copy in the IMAP Sent folder so it shows in webmail.
  // A failure here never fails the send — the mail already went out.
  let copiedToSent = false;
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(message).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
    });
    const res = await appendToSent(raw);
    copiedToSent = res.ok;
  } catch {
    // ignore — Sent copy is non-critical
  }
  return { ok: true, copiedToSent };
}
