import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { secretMatches } from "@/lib/auth/secret";

// HeyReach webhook. Match the lead on its LinkedIn profile URL (the /in/<handle>
// part, to survive www/trailing-slash differences) — EVERY live contact with
// that handle, since two workspaces can hold the same prospect and this runs
// with the service role: each match is processed in its own workspace. A reply
// is stored verbatim as an interaction and flips the contact to responded; an
// accepted connection advances the stage; SENT is when a queued touch truly
// becomes sent. Secured by ?token=.
//
// Write failures return 5xx so HeyReach redelivers; the per-workspace
// message_id dedupe makes redelivery idempotent.

function handleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\/+$/, "") : null;
}

// ilike treats % and _ as wildcards; escape so the handle matches literally.
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

  const event = String(body.eventType ?? body.event_type ?? body.event ?? "").toUpperCase();
  const lead = (body.lead ?? {}) as Record<string, unknown>;
  const profileUrl = String(lead.profileUrl ?? body.profileUrl ?? lead.linkedInUrl ?? "");
  const handle = handleFromUrl(profileUrl);
  if (!handle) return NextResponse.json({ ok: true, note: "no profile url" });

  const supabase = createAdminClient();
  // The ilike is a coarse pre-filter (escaped, but still substring-open:
  // "/in/jo" would match "/in/john"); the exact check below compares the
  // PARSED handle of each candidate so only true matches are processed.
  const { data: candidates, error: matchError } = await supabase
    .from("contacts")
    .select("id, workspace_id, linkedin_url")
    .ilike("linkedin_url", `%/in/${likeEscape(handle)}%`)
    .is("deleted_at", null);
  if (matchError) {
    return NextResponse.json({ error: matchError.message }, { status: 500 });
  }
  const matches = (candidates ?? []).filter((c) => handleFromUrl(c.linkedin_url) === handle);
  if (!matches.length) return NextResponse.json({ ok: true, note: "no matching contact" });

  const failures: string[] = [];
  for (const contact of matches) {
    const err = await processEvent(supabase, contact, event, body, lead);
    if (err) failures.push(err);
  }
  if (failures.length) {
    return NextResponse.json({ error: failures.join("; ") }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

async function processEvent(
  supabase: SupabaseAdmin,
  contact: { id: string; workspace_id: string },
  event: string,
  body: Record<string, unknown>,
  lead: Record<string, unknown>,
): Promise<string | null> {
  const writeErrors: string[] = [];
  if (event.includes("REPLY")) {
    const now = new Date().toISOString();
    // Verbatim reply capture. Payload shapes vary across HeyReach event
    // versions, so take the likeliest text field and fall back to the
    // serialized message object — triage (disposition) stays human.
    const msg = body.message ?? body.replyMessage ?? body.reply ?? lead.message;
    const text =
      typeof msg === "string" && msg.trim()
        ? msg
        : typeof body.messageText === "string" && body.messageText.trim()
          ? body.messageText
          : JSON.stringify(msg ?? body);
    // Link the interaction to the most recent live outbound touch; only
    // sent/delivered may flip to replied — never planned/queued drafts.
    const { data: touch } = await supabase
      .from("touches")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("channel", "linkedin")
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered"])
      .is("deleted_at", null)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    // Webhook providers redeliver on timeout/5xx — make the capture
    // idempotent. Prefer a stable payload id as the dedupe key (check-then-
    // insert against interactions.message_id, like the IMAP path); when the
    // payload carries none, skip if an identical interaction for this
    // contact landed in the last 7 days.
    const rawId =
      body.messageId ??
      body.message_id ??
      (typeof msg === "object" && msg !== null
        ? (msg as Record<string, unknown>).id
        : undefined) ??
      body.conversationId ??
      body.conversation_id;
    const messageId =
      rawId != null && String(rawId).trim() ? `heyreach:${String(rawId).trim()}` : null;
    let duplicate = false;
    if (messageId) {
      // Scoped to this contact's workspace — the unique key is
      // (workspace_id, message_id), migration 031.
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
        .eq("source", "heyreach")
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
        touch_id: touch?.id ?? null,
        channel: "linkedin",
        source: "heyreach",
        raw_content: text,
        message_id: messageId,
        occurred_at: now,
      });
      if (insertError) writeErrors.push(`interaction: ${insertError.message}`);
    }
    const { error: flipError } = await supabase
      .from("contacts")
      .update({ responded: true, responded_at: now, stage: "responded" })
      .eq("id", contact.id);
    if (flipError) writeErrors.push(`contact flip: ${flipError.message}`);
    const { error: touchError } = await supabase
      .from("touches")
      .update({ status: "replied", replied_at: now })
      .eq("contact_id", contact.id)
      .eq("channel", "linkedin")
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered"]);
    if (touchError) writeErrors.push(`touches: ${touchError.message}`);
  } else if (event.includes("ACCEPTED")) {
    const { error } = await supabase
      .from("contacts")
      .update({ stage: "in_conversation" })
      .eq("id", contact.id)
      .eq("responded", false);
    if (error) writeErrors.push(`stage: ${error.message}`);
  } else if (event.includes("SENT")) {
    // Lead-add leaves the touch 'queued'; this webhook is the moment the
    // message actually went out, so queued -> sent + sent_at. A second
    // SENT/DELIVERED signal advances sent -> delivered.
    const { data: flipped, error: sentError } = await supabase
      .from("touches")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("contact_id", contact.id)
      .eq("channel", "linkedin")
      .eq("direction", "outbound")
      .eq("status", "queued")
      .select("id");
    if (sentError) writeErrors.push(`sent flip: ${sentError.message}`);
    else if (!flipped?.length) {
      const { error } = await supabase
        .from("touches")
        .update({ status: "delivered" })
        .eq("contact_id", contact.id)
        .eq("channel", "linkedin")
        .eq("direction", "outbound")
        .eq("status", "sent");
      if (error) writeErrors.push(`delivered flip: ${error.message}`);
    }
  }

  return writeErrors.length ? writeErrors.join("; ") : null;
}
