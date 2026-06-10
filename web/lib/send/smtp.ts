import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

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
}): Promise<{ ok: boolean; error?: string }> {
  const from = process.env.MAIL_FROM; // e.g. "Ripley <ripley@cohesium.co>"
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !from) {
    return { ok: false, error: "SMTP not configured (SMTP_HOST / SMTP_USER / MAIL_FROM)." };
  }
  try {
    await transporter().sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SMTP send failed: ${e instanceof Error ? e.message : e}` };
  }
}
