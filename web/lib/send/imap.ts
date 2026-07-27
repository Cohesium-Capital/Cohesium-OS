import "server-only";
import type { Readable } from "node:stream";
import { ImapFlow, type MessageStructureObject } from "imapflow";

// Every function here takes the mailbox EXPLICITLY. These used to read
// process.env.IMAP_*, which was one mailbox for the whole instance — with
// per-workspace identities (migration 036) that silently pointed every
// tenant's Sent copies and reply capture at the operator's inbox. The caller
// resolves an identity and passes its IMAP half; env values only ever arrive
// here via the operator workspace's own identity resolution.
export type ImapConfig = {
  host: string | null;
  port: number;
  user: string | null;
  pass: string | null;
};

export function imapConfigured(cfg: ImapConfig): boolean {
  return !!(cfg.host && cfg.user && cfg.pass);
}

// Save a copy of an outgoing message to the mailbox's Sent folder. SMTP sending
// does not populate "Sent" (that's an IMAP-side action a mail client normally
// does), so app-sent mail is invisible in webmail without this. Best-effort:
// callers send first and append after, ignoring failures here.
export async function appendToSent(
  raw: Buffer | string,
  cfg: ImapConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (!imapConfigured(cfg)) {
    return { ok: false, error: "IMAP not configured for this identity." };
  }

  const client = new ImapFlow({
    host: cfg.host!,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user!, pass: cfg.pass! },
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
  days: number,
  cfg: ImapConfig,
): Promise<{ ok: boolean; senders: string[]; error?: string }> {
  if (!imapConfigured(cfg)) {
    return { ok: false, senders: [], error: "IMAP not configured for this identity." };
  }

  const client = new ImapFlow({
    host: cfg.host!,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user!, pass: cfg.pass! },
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

export type InboxMessage = {
  fromAddress: string;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: string; // header date, falling back to INTERNALDATE
  text: string;
  headers: Record<string, string>;
};

// RFC 5322 headers: unfold continuation lines, then split name: value. Repeated
// headers (e.g. Received) are joined so the stored object stays flat.
function parseHeaders(raw?: Buffer): Record<string, string> {
  if (!raw) return {};
  const unfolded = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

// First non-attachment text/plain node. A non-multipart text message has no
// part number on its root node; BODY[1] addresses it.
function findTextPart(node?: MessageStructureObject): string | null {
  if (!node) return null;
  if (node.type?.toLowerCase() === "text/plain" && node.disposition !== "attachment") {
    return node.part ?? "1";
  }
  for (const child of node.childNodes ?? []) {
    const found = findTextPart(child);
    if (found) return found;
  }
  return null;
}

// The machine-readable half of a multipart/report DSN. Final-Recipient,
// Action and Status live in a message/delivery-status part, never in the
// human-readable text/plain blurb findTextPart selects.
function findDeliveryStatusPart(node?: MessageStructureObject): string | null {
  if (!node) return null;
  if (node.type?.toLowerCase() === "message/delivery-status") {
    return node.part ?? "1";
  }
  for (const child of node.childNodes ?? []) {
    const found = findDeliveryStatusPart(child);
    if (found) return found;
  }
  return null;
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

// Fetch recent INBOX messages with enough context to capture replies and
// bounces verbatim: envelope + full headers (In-Reply-To/References for touch
// matching) + the decoded plain-text body. Read-only — flags are never
// mutated, so re-polling the same rolling window is safe; callers dedupe on
// messageId against interactions.message_id.
export async function fetchRecentMessages(
  days: number,
  cfg: ImapConfig,
): Promise<{ ok: boolean; messages: InboxMessage[]; error?: string }> {
  if (!imapConfigured(cfg)) {
    return { ok: false, messages: [], error: "IMAP not configured for this identity." };
  }

  const client = new ImapFlow({
    host: cfg.host!,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user!, pass: cfg.pass! },
    logger: false,
  });

  const messages: InboxMessage[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - days * 86400000);
      const list = await client.search({ since }, { uid: true });
      if (Array.isArray(list) && list.length) {
        // Bound a pathological window; UIDs ascend, so slicing from the end
        // keeps the newest messages.
        const uids = list.slice(-300);
        const fetched = await client.fetchAll(
          uids,
          { envelope: true, bodyStructure: true, internalDate: true, headers: true },
          { uid: true },
        );
        for (const msg of fetched) {
          const env = msg.envelope;
          const fromAddress = env?.from?.[0]?.address?.toLowerCase() ?? "";
          if (!fromAddress || !msg.uid) continue;
          const headers = parseHeaders(msg.headers);

          // download() decodes the transfer encoding for us. Some DSNs carry
          // no text/plain part — fall back to a raw source snippet so triage
          // still gets something verbatim.
          let text = "";
          const part = findTextPart(msg.bodyStructure);
          if (part) {
            try {
              const dl = await client.download(String(msg.uid), part, {
                uid: true,
                maxBytes: 256 * 1024,
              });
              if (dl?.content) text = (await streamToString(dl.content)).trim();
            } catch {
              // fall through to the raw snippet
            }
          }
          // Append the delivery-status part (when present) so DSN callers can
          // read Final-Recipient/Action/Status reliably — the text/plain part
          // of a bounce rarely carries them.
          const dsPart = findDeliveryStatusPart(msg.bodyStructure);
          if (dsPart && dsPart !== part) {
            try {
              const dl = await client.download(String(msg.uid), dsPart, {
                uid: true,
                maxBytes: 256 * 1024,
              });
              if (dl?.content) {
                const ds = (await streamToString(dl.content)).trim();
                if (ds) text = text ? `${text}\n\n${ds}` : ds;
              }
            } catch {
              // best-effort — the raw snippet fallback may still contain it
            }
          }
          if (!text) {
            const one = await client.fetchOne(
              String(msg.uid),
              { source: { maxLength: 16384 } },
              { uid: true },
            );
            if (one && one.source) text = one.source.toString("utf8").trim();
          }
          if (!text) continue; // interactions.raw_content is NOT NULL

          const when =
            env?.date instanceof Date && !Number.isNaN(env.date.getTime())
              ? env.date
              : msg.internalDate
                ? new Date(msg.internalDate)
                : new Date();
          messages.push({
            fromAddress,
            subject: env?.subject ?? headers["subject"] ?? "",
            messageId: env?.messageId ?? headers["message-id"] ?? null,
            inReplyTo: env?.inReplyTo ?? headers["in-reply-to"] ?? null,
            references: (headers["references"] ?? "").split(/\s+/).filter(Boolean),
            date: when.toISOString(),
            text,
            headers,
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, messages };
  } catch (e) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    return { ok: false, messages, error: `IMAP failed: ${e instanceof Error ? e.message : e}` };
  }
}
