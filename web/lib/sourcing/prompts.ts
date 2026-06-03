// Builds the research prompt you paste into Claude/ChatGPT (with web search on).
// The model returns JSON matching the contract in lib/contracts.ts, which you
// paste back into the importer. Keeping the heavy research on your subscription
// instead of the metered API is the project's cost lever.

export type SourcingMode =
  | "research_msps"
  | "research_customers"
  | "find_customers_for_msps";

export type Msp = { name: string; domain: string | null };

export type PromptParams = {
  mode: SourcingMode;
  region?: string;
  profile?: string;
  count?: number;
  countPer?: number;
  msps?: Msp[];
};

const CONTRACT = `Return ONLY a single JSON object. No markdown, no code fences, no commentary
before or after it. The object must match this shape exactly:

{
  "organizations": [
    {
      "name": string,                     // the company's name
      "domain": string | null,            // primary website host, e.g. "acme.com" (no https://, no path)
      "hq_city": string | null,
      "hq_state": string | null,          // 2-letter state/province code where applicable
      "current_msp_name": string | null,  // the managed IT provider this company uses, if known/estimated
      "source_url": string | null,        // a URL that backs this row
      "confidence": "high" | "medium" | "low",
      "contacts": [
        {
          "full_name": string | null,
          "persona": "owner" | "head_of_it" | "other",
          "title": string | null,
          "linkedin_url": string | null,
          "source_url": string | null,
          "confidence": "high" | "medium" | "low"
        }
      ]
    }
  ]
}`;

const RULES = `Rules:
- Use web search to ground every row. Do NOT invent a company, person, domain,
  or MSP relationship. A fabricated row poisons the dataset, which is the asset
  being built. An honest omission is always better than a confident guess.
- For anything not verifiable, use null and set "confidence" to "low".
- "confidence" reflects how sure you are that the entity is real AND that the
  stated relationship (e.g. which MSP they use) is true. Reserve "high" for
  facts backed by a clear, citable source.
- Always include a "source_url" when you can. Put a real URL or null.
- Output the JSON object and nothing else.`;

export function buildPrompt(params: PromptParams): string {
  const region = params.region?.trim() || "the United States";
  const profile = params.profile?.trim();

  if (params.mode === "research_msps") {
    const count = params.count ?? 25;
    return [
      `You are sourcing managed IT service providers (MSPs) as potential acquisition targets.`,
      `Find up to ${count} real MSPs based in ${region}.`,
      profile ? `Target profile: ${profile}.` : "",
      `For each MSP, set "current_msp_name" to null and leave "contacts" as an empty array unless a leader is clearly named. Every organization you return is an MSP.`,
      "",
      CONTRACT,
      "",
      RULES,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (params.mode === "research_customers") {
    const count = params.count ?? 25;
    return [
      `You are sourcing companies that USE a managed IT service provider (an MSP), so we can study the MSP market.`,
      `Find up to ${count} real companies based in ${region} that outsource their IT to an MSP.`,
      profile ? `Target profile: ${profile}.` : "",
      `For each company, estimate "current_msp_name" (the MSP they use) when you can find evidence, and set its "confidence" accordingly. Identify a contact who is the owner/decision-maker ("owner") or who leads IT ("head_of_it") when findable. Every organization you return is a customer (not an MSP).`,
      "",
      CONTRACT,
      "",
      RULES,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // find_customers_for_msps
  const countPer = params.countPer ?? 10;
  const msps = (params.msps ?? []).filter((m) => m.name?.trim());
  const list = msps.length
    ? msps
        .map((m) => `- ${m.name}${m.domain ? ` (${m.domain})` : ""}`)
        .join("\n")
    : "- (no MSPs provided)";
  return [
    `You are finding the CUSTOMERS of specific managed IT service providers (MSPs), so we can study how their clients work with them.`,
    `For each MSP listed below, find up to ${countPer} real companies that are its clients.`,
    profile ? `Prefer customers matching: ${profile}.` : "",
    `Set each customer's "current_msp_name" to the EXACT MSP name from this list it belongs to. Set "confidence" by how clearly that client relationship is documented. Identify an owner/decision-maker ("owner") or IT lead ("head_of_it") contact when findable. Every organization you return is a customer.`,
    "",
    `MSPs:`,
    list,
    "",
    CONTRACT,
    "",
    RULES,
  ]
    .filter(Boolean)
    .join("\n");
}
