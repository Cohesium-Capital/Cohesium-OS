import "server-only";

// Thin wrappers over the Smartlead and HeyReach lead-add endpoints. Per-lead
// personalization rides in custom fields the campaign sequence references as
// merge tags ({{email_subject}}/{{email_body}}, {{connection_note}}).

export type SmartleadLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  custom_fields: Record<string, string>;
};

export async function smartleadAddLeads(
  apiKey: string,
  campaignId: string,
  leads: SmartleadLead[],
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads?api_key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_list: leads,
        settings: { ignore_duplicate_leads_in_other_campaign: false },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Smartlead ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Smartlead request failed: ${e instanceof Error ? e.message : e}` };
  }
}

export type HeyreachLead = {
  profileUrl: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  position?: string;
  customUserFields: { name: string; value: string }[];
};

export async function heyreachAddLeads(
  apiKey: string,
  campaignId: string,
  accountId: string,
  leads: HeyreachLead[],
): Promise<{ ok: boolean; error?: string }> {
  const url = "https://api.heyreach.io/api/public/campaign/AddLeadsToCampaignV2";
  const accountLeadPairs = leads.map((lead) => ({
    linkedInAccountId: Number(accountId),
    lead,
  }));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: Number(campaignId), accountLeadPairs }),
    });
    if (!res.ok) {
      return { ok: false, error: `HeyReach ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `HeyReach request failed: ${e instanceof Error ? e.message : e}` };
  }
}
