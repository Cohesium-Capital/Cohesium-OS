/**
 * One-off: verify cohesium.co SMTP send + IMAP read using local .env.local.
 *   npx tsx scripts/test-email.ts [to-address]
 */
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

async function main() {
  const to = process.argv[2] || env.SMTP_USER;
  const port = Number(env.SMTP_PORT ?? 465);

  console.log("SMTP send ->", to);
  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: env.MAIL_FROM,
      to,
      subject: "Cohesium send-layer test",
      text: "If you can read this, cohesium.co SMTP is working. Automated test, no action needed.",
    });
    console.log("   send: ok");
  } catch (e) {
    console.log("   send FAILED:", e instanceof Error ? e.message : e);
  }

  console.log("IMAP read of INBOX (last 1 day)…");
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: Number(env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASS },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    const senders: string[] = [];
    try {
      const since = new Date(Date.now() - 86400000);
      const list = await client.search({ since }, { uid: true });
      if (Array.isArray(list) && list.length) {
        for await (const msg of client.fetch(list, { envelope: true }, { uid: true })) {
          const a = msg.envelope?.from?.[0]?.address;
          if (a) senders.push(a);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    console.log(
      "   imap: ok —",
      senders.length,
      "msg; senders:",
      [...new Set(senders)].slice(0, 8).join(", ") || "(none)",
    );
  } catch (e) {
    console.log("   imap FAILED:", e instanceof Error ? e.message : e);
  }
}

main();
