"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import {
  smartleadAddLeads,
  heyreachAddLeads,
  type SmartleadLead,
  type HeyreachLead,
} from "./providers";
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
// reply, so this is belt-and-suspenders.
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
    .eq("approved", true);
  if (error) return { ...report, ok: false, error: error.message };

  const rows = (data ?? []) as unknown as TouchRow[];
  const active = rows.filter((t) => t.contacts && !t.contacts.responded);
  report.skippedResponded = rows.length - active.length;

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

  // --- Email -> Smartlead -------------------------------------------------
  const emailTouches = active.filter((t) => t.channel === "email" && t.contacts!.email);
  if (emailTouches.length) {
    const key = process.env.SMARTLEAD_API_KEY;
    const campaign = process.env.SMARTLEAD_CAMPAIGN_ID;
    if (!key || !campaign) {
      report.errors.push("Smartlead not configured (SMARTLEAD_API_KEY / SMARTLEAD_CAMPAIGN_ID).");
    } else {
      const leads: SmartleadLead[] = emailTouches.map((t) => {
        const { first, last } = splitName(t.contacts!.full_name);
        return {
          email: t.contacts!.email!,
          first_name: first,
          last_name: last,
          company_name: orgName.get(t.contacts!.organization_id),
          custom_fields: { email_subject: t.subject ?? "", email_body: t.body },
        };
      });
      let ok = true;
      for (let i = 0; i < leads.length; i += 400) {
        const r = await smartleadAddLeads(key, campaign, leads.slice(i, i + 400));
        if (!r.ok) {
          report.errors.push(r.error!);
          ok = false;
          break;
        }
      }
      if (ok) {
        const { error: ue } = await supabase
          .from("touches")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            provider: "smartlead",
          })
          .in("id", emailTouches.map((t) => t.id));
        if (ue) report.errors.push(`Mark sent (email): ${ue.message}`);
        else report.emailSent = emailTouches.length;
      }
    }
  }

  // --- LinkedIn -> HeyReach ----------------------------------------------
  const liTouches = active.filter((t) => t.channel === "linkedin" && t.contacts!.linkedin_url);
  if (liTouches.length) {
    const key = process.env.HEYREACH_API_KEY;
    const campaign = process.env.HEYREACH_CAMPAIGN_ID;
    const account = process.env.HEYREACH_ACCOUNT_ID;
    if (!key || !campaign || !account) {
      report.errors.push(
        "HeyReach not configured (HEYREACH_API_KEY / HEYREACH_CAMPAIGN_ID / HEYREACH_ACCOUNT_ID).",
      );
    } else {
      const leads: HeyreachLead[] = liTouches.map((t) => {
        const { first, last } = splitName(t.contacts!.full_name);
        return {
          profileUrl: t.contacts!.linkedin_url!,
          firstName: first,
          lastName: last,
          companyName: orgName.get(t.contacts!.organization_id),
          customUserFields: [{ name: "connection_note", value: t.body }],
        };
      });
      const r = await heyreachAddLeads(key, campaign, account, leads);
      if (!r.ok) {
        report.errors.push(r.error!);
      } else {
        const { error: ue } = await supabase
          .from("touches")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            provider: "heyreach",
          })
          .in("id", liTouches.map((t) => t.id));
        if (ue) report.errors.push(`Mark sent (linkedin): ${ue.message}`);
        else report.linkedinSent = liTouches.length;
      }
    }
  }

  if (report.errors.length && !report.emailSent && !report.linkedinSent) {
    report.ok = false;
  }
  revalidatePath("/draft/queue");
  return report;
}
