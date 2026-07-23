"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { heyreachAddLeads, type HeyreachLead } from "./providers";
import { type SendReport, EMPTY_SEND_REPORT } from "./types";

type TouchRow = {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  contacts: {
    id: string;
    full_name: string | null;
    email: string | null;
    linkedin_url: string | null;
    responded: boolean;
    organization_id: string;
  } | null;
};

function splitName(full: string | null): { first?: string; last?: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return { first: parts[0], last: parts.slice(1).join(" ") || undefined };
}

// Push approved, not-yet-sent touches to the providers. Contacts who already
// replied are skipped (the global stop flag), and providers also auto-stop on
// reply, so this is belt-and-suspenders. Suppressed contacts are excluded for
// every channel — 'pending' rows block too, until a human confirms in triage.
export async function sendApproved(): Promise<SendReport> {
  await requireUser();
  const supabase = await createClient();
  const report: SendReport = { ...EMPTY_SEND_REPORT, errors: [] };

  const { data, error } = await supabase
    .from("touches")
    .select(
      "id, channel, subject, body, contacts!inner(id, full_name, email, linkedin_url, responded, organization_id)",
    )
    .eq("status", "planned")
    .eq("direction", "outbound")
    .eq("approved", true)
    .is("deleted_at", null)
    .is("contacts.deleted_at", null);
  if (error) return { ...report, ok: false, error: error.message };

  const rows = ((data ?? []) as unknown as TouchRow[]).filter((t) => t.contacts);

  // Suppression is channel-agnostic: any active or pending row blocks the
  // contact everywhere.
  const { data: sup, error: se } = await supabase
    .from("suppressions")
    .select("contact_id")
    .in("status", ["active", "pending"]);
  if (se) return { ...report, ok: false, error: se.message };
  const suppressed = new Set((sup ?? []).map((s) => s.contact_id));

  const unsuppressed = rows.filter((t) => !suppressed.has(t.contacts!.id));
  report.skippedSuppressed = rows.length - unsuppressed.length;
  const active = unsuppressed.filter((t) => !t.contacts!.responded);
  report.skippedResponded = unsuppressed.length - active.length;

  // Resolve company names for the leads.
  const orgIds = [
    ...new Set(active.map((t) => t.contacts!.organization_id).filter(Boolean)),
  ];
  const orgName = new Map<string, string>();
  if (orgIds.length) {
    const { data: orgs } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    orgs?.forEach((o) => orgName.set(o.id, o.name));
  }

  // --- Email -> queue for the SMTP drip worker ----------------------------
  // We don't blast; we mark approved email touches 'queued' and the cron route
  // (/api/cron/email) drip-sends them from cohesium.co a few at a time.
  const emailTouches = active.filter((t) => t.channel === "email" && t.contacts!.email);
  if (emailTouches.length) {
    const { error: ue } = await supabase
      .from("touches")
      .update({ status: "queued" })
      .in("id", emailTouches.map((t) => t.id));
    if (ue) report.errors.push(`Queue email: ${ue.message}`);
    else report.emailQueued = emailTouches.length;
  }

  // --- LinkedIn -> HeyReach ----------------------------------------------
  const liAll = active.filter((t) => t.channel === "linkedin" && t.contacts!.linkedin_url);
  if (liAll.length) {
    const key = process.env.HEYREACH_API_KEY;
    const campaign = process.env.HEYREACH_CAMPAIGN_ID;
    const account = process.env.HEYREACH_ACCOUNT_ID;
    if (!key || !campaign || !account) {
      report.errors.push(
        "HeyReach not configured (HEYREACH_API_KEY / HEYREACH_CAMPAIGN_ID / HEYREACH_ACCOUNT_ID).",
      );
    } else {
      // Rolling-24h cap (mirrors EMAIL_DAILY_CAP): scheduled_at marks when we
      // handed the lead to HeyReach, so it is the counter for the window.
      const cap = Number(process.env.LINKEDIN_DAILY_CAP ?? 20);
      const since24 = new Date(Date.now() - 86_400_000).toISOString();
      const { count: pushed24 } = await supabase
        .from("touches")
        .select("id", { count: "exact", head: true })
        .eq("provider", "heyreach")
        .gte("scheduled_at", since24);
      const room = Math.max(0, cap - (pushed24 ?? 0));
      const liTouches = liAll.slice(0, room);
      report.skippedLinkedinCap = liAll.length - liTouches.length;

      if (liTouches.length) {
        const leads: HeyreachLead[] = liTouches.map((t) => {
          const { first, last } = splitName(t.contacts!.full_name);
          return {
            profileUrl: t.contacts!.linkedin_url!,
            firstName: first,
            lastName: last,
            companyName: orgName.get(t.contacts!.organization_id),
            // Field name must match the sequence variable exactly: {CONNECTION_NOTE}.
            customUserFields: [{ name: "CONNECTION_NOTE", value: t.body }],
          };
        });
        const r = await heyreachAddLeads(key, campaign, account, leads);
        if (!r.ok) {
          report.errors.push(r.error!);
        } else {
          // Lead-add only queues the message inside HeyReach — 'sent' would be
          // a lie here. The SENT webhook flips queued -> sent when the request
          // actually goes out.
          const { error: ue } = await supabase
            .from("touches")
            .update({
              status: "queued",
              scheduled_at: new Date().toISOString(),
              provider: "heyreach",
            })
            .in("id", liTouches.map((t) => t.id));
          if (ue) report.errors.push(`Queue linkedin: ${ue.message}`);
          else report.linkedinQueued = liTouches.length;
        }
      }
    }
  }

  report.linkedinSent = report.linkedinQueued; // deprecated alias
  if (report.errors.length && !report.emailQueued && !report.linkedinQueued) {
    report.ok = false;
  }
  revalidatePath("/draft/queue");
  return report;
}
