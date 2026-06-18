import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/send/smtp";
import { fetchRecentSenders } from "@/lib/send/imap";

// Scheduled email worker. Each run: (1) polls the inbox and flips contacts who
// replied (stop flag), then (2) drip-sends up to EMAIL_BATCH queued emails.
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; an external
// scheduler can pass `?token=$CRON_SECRET` instead.

export const maxDuration = 300;

type QueuedTouch = {
  id: string;
  subject: string | null;
  body: string;
  contacts: { email: string | null; responded: boolean } | null;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const header = req.headers.get("authorization") ?? "";
  const token = searchParams.get("token") ?? header.replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  // One cron run per weekday sends up to EMAIL_BATCH, bounded by the rolling-24h
  // EMAIL_DAILY_CAP — so the effective rate is ~20/weekday at the defaults.
  const batch = Number(process.env.EMAIL_BATCH ?? 20);
  const result = { sent: 0, copiedToSent: 0, repliesDetected: 0, errors: [] as string[] };

  // 1. Reply poll → responded stop-flag.
  const replies = await fetchRecentSenders(3);
  if (!replies.ok && replies.error) result.errors.push(replies.error);
  const uniqueSenders = [...new Set(replies.senders)];
  if (uniqueSenders.length) {
    const { data: matched } = await supabase
      .from("contacts")
      .select("id")
      .in("email", uniqueSenders)
      .eq("responded", false);
    for (const c of matched ?? []) {
      await supabase
        .from("contacts")
        .update({ responded: true, responded_at: new Date().toISOString(), stage: "responded" })
        .eq("id", c.id);
      await supabase
        .from("touches")
        .update({ status: "replied" })
        .eq("contact_id", c.id)
        .eq("channel", "email")
        .eq("direction", "outbound");
      result.repliesDetected++;
    }
  }

  // 2. Daily cap (warmup-friendly): never exceed EMAIL_DAILY_CAP sends per
  //    rolling 24h, regardless of how often the cron runs.
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

  // 3. Drip-send queued emails (skip anyone who has since replied).
  const { data: queued } = await supabase
    .from("touches")
    .select("id, subject, body, contacts!inner(email, responded)")
    .eq("status", "queued")
    .eq("channel", "email")
    .eq("direction", "outbound")
    .limit(take * 3);
  const sendable = ((queued ?? []) as unknown as QueuedTouch[])
    .filter((t) => t.contacts && !t.contacts.responded && t.contacts.email)
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
        .update({ status: "sent", sent_at: new Date().toISOString(), provider: "smtp" })
        .eq("id", t.id);
      result.sent++;
      if (r.copiedToSent) result.copiedToSent++;
    } else {
      result.errors.push(`${t.contacts!.email}: ${r.error}`);
    }
  }

  return NextResponse.json(result);
}
