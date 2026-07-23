import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/send/smtp";
import { fetchRecentMessages, type InboxMessage } from "@/lib/send/imap";

// Scheduled email worker. Each run: (1) captures replies and bounces from the
// inbox verbatim into `interactions` (deduped on Message-ID) and flips the
// matching touches/contacts/suppressions, then (2) drip-sends up to
// EMAIL_BATCH queued emails, skipping suppressed contacts. Capture runs first
// so a reply or bounce landing minutes ago stops this run's sends.
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; an external
// scheduler can pass `?token=$CRON_SECRET` instead.
// Schedule (vercel.json): 2x per weekday, so each run polls replies/bounces
// before its send window. External callers using `?token=$CRON_SECRET` are
// not bound by that schedule and can fire at any time.

export const maxDuration = 300;

type QueuedTouch = {
  id: string;
  subject: string | null;
  body: string;
  contacts: { id: string; email: string | null; responded: boolean } | null;
};

// Conservative opt-out matcher. A hit creates a PENDING suppression that
// blocks sends until a human confirms or revokes it in triage — the reply
// itself is never auto-classified (disposition stays null for the human).
const OPT_OUT_RE = /unsubscribe|remove me|stop email|opt.?out|don.?t contact/i;

// DSN/bounce heuristics: mailer daemons and the usual failure subjects.
function isDsn(m: InboxMessage): boolean {
  return (
    /^(mailer-daemon|postmaster)@/i.test(m.fromAddress) ||
    /undeliverable|delivery status|returned mail/i.test(m.subject)
  );
}

// Hard vs soft DSN. Only a provably permanent failure — the machine-readable
// `Action: failed` or a 5.x.x status (imap.ts appends the delivery-status
// part to m.text) — may create do-not-contact state without a human. Delay
// notices ("will be retried") and unclassifiable DSNs are soft.
function isHardDsn(m: InboxMessage): boolean {
  // Delay/warning notices are explicitly soft, whatever the body quotes.
  if (/delay|delayed|warning|still being retried|not yet been delivered/i.test(m.subject)) {
    return false;
  }
  if (/^action:\s*failed\b/im.test(m.text)) return true;
  if (/^status:\s*5\.\d{1,3}\.\d{1,3}/im.test(m.text)) return true;
  return false; // indeterminate: soft — never auto-suppress without evidence
}

// ilike treats % and _ as wildcards (backslash escapes them); underscores are
// routine in emails, so escape before building a pattern.
function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

// RFC 3834 auto-reply markers (OOO/vacation responders). Auto-generated mail
// must not count as a human response.
function isAutoReply(headers: Record<string, string>): boolean {
  const auto = headers["auto-submitted"];
  if (auto && !/^no\b/i.test(auto)) return true;
  if ("x-autoreply" in headers || "x-autorespond" in headers) return true;
  return /auto[_-]?reply/i.test(headers["precedence"] ?? "");
}

// Pull the failed recipient out of a DSN: prefer the machine-readable
// Final-/Original-Recipient fields, else the first angle-bracketed address in
// the body that isn't our own sender.
function bouncedRecipient(text: string, selfAddress: string | null): string | null {
  const structured = text.match(
    /(?:final|original)-recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+?)>?(?:\s|$)/i,
  );
  if (structured) return structured[1].toLowerCase();
  for (const m of text.matchAll(/<([^\s<>]+@[^\s<>]+)>/g)) {
    const addr = m[1].toLowerCase();
    if (addr !== selfAddress) return addr;
  }
  return null;
}

// Message-IDs appear with and without angle brackets depending on the source.
function normalizeMid(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const header = req.headers.get("authorization") ?? "";
  const token = searchParams.get("token") ?? header.replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  // The cron fires 2x per weekday; the rolling-24h EMAIL_DAILY_CAP below (not
  // the schedule) bounds total volume, so the effective rate stays ~20/weekday
  // at the defaults.
  const batch = Number(process.env.EMAIL_BATCH ?? 20);
  const result = {
    repliesCaptured: 0,
    bouncesCaptured: 0,
    optOutsPending: 0,
    sent: 0,
    failed: 0,
    skippedSuppressed: 0,
    copiedToSent: 0,
    errors: [] as string[],
  };
  const selfAddress =
    ((process.env.MAIL_FROM ?? "").match(/<([^<>]+)>/)?.[1] ?? process.env.MAIL_FROM ?? "")
      .trim()
      .toLowerCase() || null;

  // ---- 1. Reply & bounce capture -----------------------------------------
  // A fetch failure still yields any partially-fetched messages — capture
  // them below, then the guard before the send window fails closed.
  const inbox = await fetchRecentMessages(7);

  // Dedupe against interactions captured by earlier polls of the same window.
  const withIds = inbox.messages.filter((m) => m.messageId);
  const seen = new Set<string>();
  if (withIds.length) {
    const { data: existing, error: de } = await supabase
      .from("interactions")
      .select("message_id")
      .in("message_id", withIds.map((m) => m.messageId!));
    if (de) {
      // A failed dedupe read must not make the whole window look "fresh" —
      // that would re-run flips and stack suppressions every poll. Fail
      // closed: skip capture AND the send window (capture-before-send).
      result.errors.push(`message-id dedupe check failed, run skipped: ${de.message}`);
      return NextResponse.json(result);
    }
    existing?.forEach((r) => r.message_id && seen.add(r.message_id));
  }
  const fresh = withIds.filter((m) => !seen.has(m.messageId!));

  // Resolve non-DSN senders to contacts in one query. Senders arrive
  // lowercased from the IMAP layer but stored contact emails may carry any
  // casing, so match case-insensitively (ilike, wildcards escaped). Addresses
  // with characters that would break the or() grammar are dropped — they
  // could never have matched the old exact lookup either.
  const senders = [
    ...new Set(fresh.filter((m) => !isDsn(m)).map((m) => m.fromAddress)),
  ].filter((s) => !/[,()"]/.test(s));
  const contactByEmail = new Map<string, string>();
  if (senders.length) {
    const { data: matched } = await supabase
      .from("contacts")
      .select("id, email")
      .or(senders.map((s) => `email.ilike.${likeEscape(s)}`).join(","))
      .is("deleted_at", null);
    matched?.forEach((c) => c.email && contactByEmail.set(c.email.toLowerCase(), c.id));
  }

  for (const m of fresh) {
    const now = new Date().toISOString();
    if (isDsn(m)) {
      // Resolve the bounced recipient to a contact + its most recent live
      // outbound email touch; unresolvable DSNs are still stored verbatim.
      // Only a hard failure flips the touch and creates an ACTIVE suppression;
      // soft/indeterminate DSNs (delays, warnings) get a PENDING 'auto_pending'
      // suppression for triage and leave the touch and disposition alone.
      const hard = isHardDsn(m);
      let contactId: string | null = null;
      let touchId: string | null = null;
      const recipient = bouncedRecipient(m.text, selfAddress);
      if (recipient) {
        const { data: contact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", likeEscape(recipient))
          .is("deleted_at", null)
          .maybeSingle();
        if (contact) {
          contactId = contact.id;
          const { data: touch } = await supabase
            .from("touches")
            .select("id")
            .eq("contact_id", contact.id)
            .eq("channel", "email")
            .eq("direction", "outbound")
            .in("status", ["sent", "delivered"])
            .is("deleted_at", null)
            .order("sent_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (touch) {
            touchId = touch.id;
            if (hard) {
              await supabase
                .from("touches")
                .update({ status: "bounced", bounced_at: now })
                .eq("id", touch.id);
            }
          }
          // Idempotent across polls: skip when a non-revoked suppression with
          // the same contact + reason already exists.
          const reason = hard ? "hard_bounce" : "auto_pending";
          const { data: dupSup } = await supabase
            .from("suppressions")
            .select("id")
            .eq("contact_id", contact.id)
            .eq("reason", reason)
            .neq("status", "revoked")
            .limit(1)
            .maybeSingle();
          if (!dupSup) {
            await supabase.from("suppressions").insert({
              contact_id: contact.id,
              reason,
              status: hard ? "active" : "pending",
              source: `dsn:${m.messageId}`,
            });
          }
        }
      }
      const { error: ie } = await supabase.from("interactions").insert({
        contact_id: contactId,
        touch_id: touchId,
        channel: "email",
        source: "imap",
        // Soft/indeterminate DSNs stay unclassified so they surface in triage.
        disposition: hard ? "bounce" : null,
        raw_content: m.text,
        headers: m.headers,
        message_id: m.messageId,
        occurred_at: m.date,
      });
      if (ie) result.errors.push(`bounce ${m.messageId}: ${ie.message}`);
      else result.bouncesCaptured++;
      continue;
    }

    const contactId = contactByEmail.get(m.fromAddress);
    if (!contactId) continue; // stranger mail is not ours to store

    // Touch match: In-Reply-To/References against the Message-IDs we stamped
    // into provider_ref at send time; fallback = most recent live outbound.
    // Only sent/delivered may flip to replied — never planned/queued drafts.
    const { data: candidates } = await supabase
      .from("touches")
      .select("id, provider_ref")
      .eq("contact_id", contactId)
      .eq("channel", "email")
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered"])
      .is("deleted_at", null)
      .order("sent_at", { ascending: false });
    const refs = new Set(
      [m.inReplyTo, ...m.references].filter((r): r is string => !!r).map(normalizeMid),
    );
    const touch =
      (candidates ?? []).find(
        (t) => t.provider_ref && refs.has(normalizeMid(t.provider_ref)),
      ) ??
      candidates?.[0] ??
      null;
    // Auto-generated mail (OOO/vacation) is stored for triage but never
    // counts as a human response: no replied flip, no responded stop-flag.
    const autoReply = isAutoReply(m.headers);
    if (touch && !autoReply) {
      await supabase
        .from("touches")
        .update({ status: "replied", replied_at: now })
        .eq("id", touch.id);
    }
    if (!autoReply) {
      await supabase
        .from("contacts")
        .update({ responded: true, responded_at: now, stage: "responded" })
        .eq("id", contactId)
        .eq("responded", false);
    }
    if (OPT_OUT_RE.test(m.text)) {
      // Idempotent across polls: skip when a non-revoked opt_out suppression
      // already exists for this contact.
      const { data: dupSup } = await supabase
        .from("suppressions")
        .select("id")
        .eq("contact_id", contactId)
        .eq("reason", "opt_out")
        .neq("status", "revoked")
        .limit(1)
        .maybeSingle();
      if (!dupSup) {
        await supabase.from("suppressions").insert({
          contact_id: contactId,
          reason: "opt_out",
          status: "pending",
          source: `reply:${m.messageId}`,
        });
        result.optOutsPending++;
      }
    }
    const { error: ie } = await supabase.from("interactions").insert({
      contact_id: contactId,
      touch_id: touch?.id ?? null,
      channel: "email",
      source: "imap",
      raw_content: m.text,
      headers: autoReply
        ? { ...m.headers, "x-capture-note": "auto-reply detected; responded/replied flips skipped" }
        : m.headers,
      message_id: m.messageId,
      occurred_at: m.date,
    });
    if (ie) result.errors.push(`reply ${m.messageId}: ${ie.message}`);
    else result.repliesCaptured++;
  }

  // ---- 2. Send window ------------------------------------------------------
  // Capture-before-send is the invariant: if the inbox fetch failed we may be
  // missing yesterday's "unsubscribe" — fail closed and skip this run's sends.
  if (!inbox.ok) {
    result.errors.push(`capture unavailable, send skipped: ${inbox.error ?? "IMAP failed"}`);
    return NextResponse.json(result);
  }

  // Config problems must never consume touches: verify SMTP env once up
  // front (same check sendMail does) and leave everything queued if missing.
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.MAIL_FROM) {
    result.errors.push(
      "SMTP not configured (SMTP_HOST / SMTP_USER / MAIL_FROM) — send skipped, touches left queued.",
    );
    return NextResponse.json(result);
  }

  // Suppression set first: any active or pending row blocks the contact.
  const { data: sup, error: se } = await supabase
    .from("suppressions")
    .select("contact_id")
    .in("status", ["active", "pending"]);
  if (se) {
    // Without the suppression set we cannot guarantee the invariant — no sends.
    result.errors.push(`suppressions unavailable, send skipped: ${se.message}`);
    return NextResponse.json(result);
  }
  const suppressedSet = new Set((sup ?? []).map((s) => s.contact_id));

  // Daily cap (warmup-friendly): never exceed EMAIL_DAILY_CAP sends per
  // rolling 24h, regardless of how often the cron runs.
  const dailyCap = Number(process.env.EMAIL_DAILY_CAP ?? 20);
  const since24 = new Date(Date.now() - 86_400_000).toISOString();
  const { count: sentToday } = await supabase
    .from("touches")
    .select("id", { count: "exact", head: true })
    .eq("provider", "smtp")
    .gte("sent_at", since24);
  const remaining = Math.max(0, dailyCap - (sentToday ?? 0));
  if (remaining <= 0) {
    return NextResponse.json({ ...result, note: "daily cap reached" });
  }
  const take = Math.min(batch, remaining);

  // Drip-send queued emails (skip anyone suppressed or who has since
  // replied). Responded contacts are excluded server-side and the window is
  // ordered + widened so blocked rows cannot occupy it and starve sendable
  // touches sitting past the limit.
  const { data: queued } = await supabase
    .from("touches")
    .select("id, subject, body, contacts!inner(id, email, responded)")
    .eq("status", "queued")
    .eq("channel", "email")
    .eq("direction", "outbound")
    .is("deleted_at", null)
    .is("contacts.deleted_at", null)
    .eq("contacts.responded", false)
    .order("id")
    .limit(take * 10);
  const rows = ((queued ?? []) as unknown as QueuedTouch[]).filter((t) => t.contacts);
  const unsuppressed = rows.filter((t) => !suppressedSet.has(t.contacts!.id));
  result.skippedSuppressed = rows.length - unsuppressed.length;
  const sendable = unsuppressed
    .filter((t) => !t.contacts!.responded && t.contacts!.email)
    .slice(0, take);

  for (const t of sendable) {
    const r = await sendMail({
      to: t.contacts!.email!,
      subject: t.subject ?? "",
      text: t.body,
    });
    if (r.ok) {
      await supabase
        .from("touches")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider: "smtp",
          provider_ref: r.messageId ?? null,
        })
        .eq("id", t.id);
      result.sent++;
      if (r.copiedToSent) result.copiedToSent++;
    } else {
      // Durable failure — no more silently-queued-forever rows.
      await supabase
        .from("touches")
        .update({ status: "failed", last_error: r.error ?? "send failed" })
        .eq("id", t.id);
      result.failed++;
      result.errors.push(`${t.contacts!.email}: ${r.error}`);
    }
  }

  return NextResponse.json(result);
}
