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

  async function updateEmailTouches(status: string, onlyFromSent = false) {
    let q = supabase
      .from("touches")
      .update({ status })
      .eq("contact_id", contact!.id)
      .eq("channel", "email")
      .eq("direction", "outbound");
    if (onlyFromSent) q = q.eq("status", "sent");
    await q;
  }

  if (event.includes("REPLY") || event.includes("REPLIED")) {
    await supabase
      .from("contacts")
      .update({
        responded: true,
        responded_at: new Date().toISOString(),
        stage: "responded",
      })
      .eq("id", contact.id);
    await updateEmailTouches("replied");
  } else if (event.includes("BOUNCE")) {
    await updateEmailTouches("bounced");
  } else if (event.includes("SENT")) {
    await updateEmailTouches("delivered", true);
  }

  return NextResponse.json({ ok: true });
}
