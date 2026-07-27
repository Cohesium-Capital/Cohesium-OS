import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/auth/secret";

// Smartlead webhook. Match the lead on email — EVERY live contact holding the
// address, because two workspaces can legitimately hold the same prospect and
// this endpoint runs with the service role (no RLS): each match is processed
// in its own workspace. A reply flips the contact to responded (global stop
// flag) and marks the email touch replied. Secured by a ?token= query param
// (Smartlead can't send custom auth headers reliably).
//
// Write failures return 5xx so the provider redelivers; the per-workspace
// message_id dedupe makes redelivery idempotent.

// ilike treats % and _ as wildcards; escape so an address is matched literally.
function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  if (!secretMatches(searchParams.get("token"), process.env.SEND_WEBHOOK_SECRET)) {
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
  const { data: matches, error: matchError } = await supabase
    .from("contacts")
    .select("id, workspace_id")
    .ilike("email", likeEscape(email))
    .is("deleted_at", null);
  if (matchError) {
    // 5xx → the provider redelivers rather than the event being lost.
    return NextResponse.json({ error: matchError.message }, { status: 500 });
  }
  if (!matches?.length) return NextResponse.json({ ok: true, note: "no matching contact" });

  const failures: string[] = [];
  for (const contact of matches) {
    const err = await processEvent(supabase, contact, event, body);
    if (err) failures.push(err);
  }
  if (failures.length) {
    return NextResponse.json({ error: failures.join("; ") }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

// One contact's worth of processing; returns an error string on any write
// failure so the caller can 5xx for redelivery.
async function processEvent(
  supabase: SupabaseAdmin,
  contact: { id: string; workspace_id: string },
  event: string,
  body: Record<string, unknown>,
): Promise<string | null> {

  // Status flips are guarded by the prior status: only a touch that actually
  // went out (sent/delivered) may become replied or bounced — never
  // planned/queued drafts.
  const writeErrors: string[] = [];
  async function updateEmailTouches(
    patch: Record<string, unknown>,
    fromStatuses?: string[],
  ) {
    let q = supabase
      .from("touches")
      .update(patch)
      .eq("contact_id", contact.id)
      .eq("channel", "email")
      .eq("direction", "outbound");
    if (fromStatuses) q = q.in("status", fromStatuses);
    const { error } = await q;
    if (error) writeErrors.push(`touches: ${error.message}`);
  }

  if (event.includes("REPLY") || event.includes("REPLIED")) {
    const now = new Date().toISOString();
    const { error: flipError } = await supabase
      .from("contacts")
      .update({ responded: true, responded_at: now, stage: "responded" })
      .eq("id", contact.id);
    if (flipError) writeErrors.push(`contact flip: ${flipError.message}`);
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
        // Scoped to this contact's workspace: the unique key is
        // (workspace_id, message_id) — migration 031 — because two workspaces
        // can both legitimately receive the same message.
        const { data: existing } = await supabase
          .from("interactions")
          .select("id")
          .eq("workspace_id", contact.workspace_id)
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
        const { error: insertError } = await supabase.from("interactions").insert({
          // The reply belongs wherever the contact does.
          workspace_id: contact.workspace_id,
          contact_id: contact.id,
          channel: "email",
          source: "smartlead",
          raw_content: text,
          message_id: messageId,
          occurred_at: now,
        });
        if (insertError) writeErrors.push(`interaction: ${insertError.message}`);
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

  return writeErrors.length ? writeErrors.join("; ") : null;
}
