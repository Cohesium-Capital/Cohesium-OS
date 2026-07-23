import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Smartlead webhook. Match the lead on email. A reply flips the contact to
// responded (global stop flag) and marks the email touch replied. Secured by a
// ?token= query param (Smartlead can't send custom auth headers reliably).

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("token") !== process.env.SEND_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const event = String(body.event_type ?? body.event ?? "").toUpperCase();
  const email = String(body.to_email ?? body.lead_email ?? body.email ?? "")
    .trim()
    .toLowerCase();
  if (!email) return NextResponse.json({ ok: true, note: "no email in payload" });

  const supabase = createAdminClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (!contact) return NextResponse.json({ ok: true, note: "no matching contact" });

  // Status flips are guarded by the prior status: only a touch that actually
  // went out (sent/delivered) may become replied or bounced — never
  // planned/queued drafts.
  async function updateEmailTouches(
    patch: Record<string, unknown>,
    fromStatuses?: string[],
  ) {
    let q = supabase
      .from("touches")
      .update(patch)
      .eq("contact_id", contact!.id)
      .eq("channel", "email")
      .eq("direction", "outbound");
    if (fromStatuses) q = q.in("status", fromStatuses);
    await q;
  }

  if (event.includes("REPLY") || event.includes("REPLIED")) {
    const now = new Date().toISOString();
    await supabase
      .from("contacts")
      .update({ responded: true, responded_at: now, stage: "responded" })
      .eq("id", contact.id);
    await updateEmailTouches(
      { status: "replied", replied_at: now },
      ["sent", "delivered"],
    );
    // Verbatim reply capture when the payload carries the text — triage
    // (disposition) stays human.
    const reply =
      body.reply_body ?? body.reply_message ?? body.reply ?? body.message ?? body.email_body;
    const text =
      typeof reply === "string" ? reply.trim() : reply ? JSON.stringify(reply) : "";
    if (text) {
      // Webhook providers redeliver on timeout/5xx — make the capture
      // idempotent. Prefer a stable payload id as the dedupe key (check-
      // then-insert against interactions.message_id, like the IMAP path);
      // when the payload carries none, skip if an identical interaction for
      // this contact landed in the last 7 days.
      const replyMsg = body.reply_message;
      const rawId =
        (typeof replyMsg === "object" && replyMsg !== null
          ? (replyMsg as Record<string, unknown>).message_id
          : undefined) ??
        body.message_id ??
        body.stats_id;
      const messageId =
        rawId != null && String(rawId).trim() ? `smartlead:${String(rawId).trim()}` : null;
      let duplicate = false;
      if (messageId) {
        const { data: existing } = await supabase
          .from("interactions")
          .select("id")
          .eq("message_id", messageId)
          .limit(1)
          .maybeSingle();
        duplicate = !!existing;
      } else {
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const { data: existing } = await supabase
          .from("interactions")
          .select("id")
          .eq("contact_id", contact.id)
          .eq("source", "smartlead")
          .eq("raw_content", text)
          .gte("occurred_at", since)
          .limit(1)
          .maybeSingle();
        duplicate = !!existing;
      }
      if (!duplicate) {
        await supabase.from("interactions").insert({
          contact_id: contact.id,
          channel: "email",
          source: "smartlead",
          raw_content: text,
          message_id: messageId,
          occurred_at: now,
        });
      }
    }
  } else if (event.includes("BOUNCE")) {
    await updateEmailTouches(
      { status: "bounced", bounced_at: new Date().toISOString() },
      ["sent", "delivered"],
    );
  } else if (event.includes("SENT")) {
    await updateEmailTouches({ status: "delivered" }, ["sent"]);
  }

  return NextResponse.json({ ok: true });
}
