import "server-only";
import { ImapFlow } from "imapflow";

// Save a copy of an outgoing message to the mailbox's Sent folder. SMTP sending
// does not populate "Sent" (that's an IMAP-side action a mail client normally
// does), so app-sent mail is invisible in webmail without this. Best-effort:
// callers send first and append after, ignoring failures here.
export async function appendToSent(
  raw: Buffer | string,
): Promise<{ ok: boolean; error?: string }> {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    return { ok: false, error: "IMAP not configured." };
  }

  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    // Prefer the folder flagged \Sent (special-use); fall back to a Sent-named
    // mailbox (Hostinger exposes "INBOX.Sent"), then a plain "Sent".
    let path = "Sent";
    try {
      const boxes = await client.list();
      const sent =
        boxes.find((b) => b.specialUse === "\\Sent") ??
        boxes.find((b) => /(^|\.)sent$/i.test(b.path));
      if (sent) path = sent.path;
    } catch {
      // keep default "Sent"
    }
    await client.append(path, raw, ["\\Seen"]);
    await client.logout();
    return { ok: true };
  } catch (e) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    return { ok: false, error: `IMAP append failed: ${e instanceof Error ? e.message : e}` };
  }
}

// Reads the outreach inbox and returns the sender addresses seen recently. The
// caller matches these against contacts to flip the responded stop-flag. We
// re-scan a rolling window each run; flipping is idempotent, so we never mutate
// message flags (which would fight with you reading the inbox).
export async function fetchRecentSenders(
  days = 3,
): Promise<{ ok: boolean; senders: string[]; error?: string }> {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    return { ok: false, senders: [], error: "IMAP not configured." };
  }

  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const senders: string[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - days * 86400000);
      const list = await client.search({ since }, { uid: true });
      if (Array.isArray(list) && list.length) {
        for await (const msg of client.fetch(list, { envelope: true }, { uid: true })) {
          const addr = msg.envelope?.from?.[0]?.address;
          if (addr) senders.push(addr.toLowerCase());
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, senders };
  } catch (e) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    return { ok: false, senders, error: `IMAP failed: ${e instanceof Error ? e.message : e}` };
  }
}
