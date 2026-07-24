import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// HeyReach webhook. Match the lead on its LinkedIn profile URL (the /in/<handle>
// part, to survive www/trailing-slash differences). A reply flips the contact to
// responded; an accepted connection advances the stage. Secured by ?token=.

function handleFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

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

  const event = String(body.eventType ?? body.event_type ?? body.event ?? "").toUpperCase();
  const lead = (body.lead ?? {}) as Record<string, unknown>;
  const profileUrl = String(lead.profileUrl ?? body.profileUrl ?? lead.linkedInUrl ?? "");
  const handle = handleFromUrl(profileUrl);
  if (!handle) return NextResponse.json({ ok: true, note: "no profile url" });

  const supabase = createAdminClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .ilike("linkedin_url", `%/in/${handle}%`)
    .maybeSingle();
  if (!contact) return NextResponse.json({ ok: true, note: "no matching contact" });

  if (event.includes("REPLY")) {
    await supabase
      .from("contacts")
      .update({
        responded: true,
        responded_at: new Date().toISOString(),
        stage: "responded",
      })
      .eq("id", contact.id);
    await supabase
      .from("touches")
      .update({ status: "replied" })
      .eq("contact_id", contact.id)
      .eq("channel", "linkedin")
      .eq("direction", "outbound");
  } else if (event.includes("ACCEPTED")) {
    await supabase
      .from("contacts")
      .update({ stage: "in_conversation" })
      .eq("id", contact.id)
      .eq("responded", false);
  } else if (event.includes("SENT")) {
    await supabase
      .from("touches")
      .update({ status: "delivered" })
      .eq("contact_id", contact.id)
      .eq("channel", "linkedin")
      .eq("direction", "outbound")
      .eq("status", "sent");
  }

  return NextResponse.json({ ok: true });
}
