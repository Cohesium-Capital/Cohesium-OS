export const meta = {
  name: "source-customers",
  description:
    "Fan out one web-research agent per MSP to find its customers; returns a per-MSP customer payload for headless import.",
  phases: [{ title: "Research", detail: "one agent per MSP, in parallel" }],
};

// args: { msps: [{ id, name, domain }], countPer?: number }
// Returns: { results: [{ mspId, mspName, payload: { organizations: [...] } }] }
// The caller then runs scripts/import.ts per result with kind=customer and
// targetMspId=mspId, so each MSP's run is logged and yield tracking works.

const CUSTOMERS_SCHEMA = {
  type: "object",
  required: ["organizations"],
  properties: {
    organizations: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "confidence"],
        properties: {
          name: { type: "string" },
          domain: { type: ["string", "null"] },
          hq_city: { type: ["string", "null"] },
          hq_state: { type: ["string", "null"] },
          current_msp_name: { type: ["string", "null"] },
          source_url: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          contacts: {
            type: "array",
            items: {
              type: "object",
              required: ["persona", "confidence"],
              properties: {
                full_name: { type: ["string", "null"] },
                persona: { type: "string", enum: ["owner", "head_of_it", "other"] },
                title: { type: ["string", "null"] },
                linkedin_url: { type: ["string", "null"] },
                source_url: { type: ["string", "null"] },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
              },
            },
          },
        },
      },
    },
  },
};

function researchPrompt(m, countPer) {
  const domain = m.domain || "<mspdomain>";
  return `You research the CUSTOMERS of a specific managed IT service provider (MSP), for honest market research. Use web search and ground every row.

MSP: ${m.name}${m.domain ? ` (${m.domain})` : ""}
Find up to ${countPer} real companies that are clients of this MSP.

Where to look (highest yield first):
- The MSP's own case studies, testimonials, and "our clients" pages, plus indexed PDFs (site:${domain} filetype:pdf).
- The client logo wall: read each logo's alt text, image filename, and link target to name the company.
- Verified review sites: Clutch, G2, UpCity, TechBehemoths, GoodFirms, FeaturedCustomers, Google reviews.
- Web-wide co-mentions: "${m.name}" (client OR customer OR "partnered with"); "${m.name}" -site:${domain} for third-party/news mentions; intext:"${m.name}" filetype:pdf.
- LinkedIn win/onboarding posts; press releases, local business-journal news, and award announcements naming the MSP.
- If a source only gives an anonymized reference (industry + city + title + first name), resolve it via LinkedIn/company sites; only assert a match with two or more corroborating clues, else omit it or set confidence "low".

Rules:
- Set every customer's current_msp_name to exactly "${m.name}".
- Find each company's domain by searching its name; null only if undiscoverable.
- Identify an owner/decision-maker ("owner") or IT lead ("head_of_it") contact when findable; prefer a real full_name, and find that contact's LinkedIn profile URL (search the person's name + company) — set linkedin_url, or null only if you genuinely cannot find it.
- A co-mention is not proof of a client relationship. Set confidence to match the evidence. Never invent a company, person, domain, or relationship. Use null where unknown.`;
}

// args may arrive as a parsed object or a JSON string depending on the runtime.
const A = typeof args === "string" ? JSON.parse(args) : args ?? {};
const msps = (A.msps ?? []).filter((m) => m && m.name);
const countPer = A.countPer ?? 10;

if (!msps.length) {
  log("No MSPs provided in args.msps — nothing to do.");
  return { results: [] };
}

log(`Researching customers for ${msps.length} MSP(s), up to ${countPer} each…`);
phase("Research");

// One agent per MSP, in parallel (embarrassingly parallel discovery work).
const results = await pipeline(msps, (m) =>
  agent(researchPrompt(m, countPer), {
    label: `research:${m.name}`,
    phase: "Research",
    schema: CUSTOMERS_SCHEMA,
  }).then((payload) => ({ mspId: m.id ?? null, mspName: m.name, payload })),
);

return { results: results.filter(Boolean) };
