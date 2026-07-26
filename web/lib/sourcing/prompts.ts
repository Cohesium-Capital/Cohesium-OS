// Builds the research prompt you paste into Claude/ChatGPT (with web search on).
// The model returns JSON matching the contract in lib/contracts.ts, which you
// paste back into the importer. Keeping the heavy research on your subscription
// instead of the metered API is the project's cost lever.

export type SourcingMode =
  | "research_msps"
  | "research_customers"
  | "find_customers_for_msps";

export type Msp = { id?: string; name: string; domain: string | null };

// Cap on the do-not-research list embedded in a pasted prompt. The list has to
// fit in a prompt an operator pastes into a chat window, and — the binding
// limit — a model stops reliably honouring a name list long before the window
// fills. Lives here rather than in the module so the Source page can show the
// operator how close they are to it without pulling server code into the
// browser bundle. The runner executor has no equivalent cap; it queries.
export const KNOWN_LIMIT = 400;

// A company the system has already researched. Rendered into the prompt as a
// do-not-return list so a re-run spends its search budget on new companies
// instead of rediscovering the ones we hold. mspName scopes the exclusion in
// find_customers_for_msps: a company is only "known" as a client of the MSP it
// is already linked to, so the same company surfacing under a different MSP is
// still new information.
export type KnownOrg = { name: string; domain?: string | null; mspName?: string | null };

export type PromptParams = {
  mode: SourcingMode;
  region?: string;
  profile?: string;
  count?: number;
  countPer?: number;
  msps?: Msp[];
  /** Already-sourced companies to exclude (filled server-side at run start). */
  known?: KnownOrg[];
  /** How many further known companies exist beyond the ones listed. */
  knownOmitted?: number;
  /**
   * Runner executor: instead of embedding a list, instruct the agent to check
   * candidates against the full database via the API. Set by prepareConfig.
   */
  checkKnownViaApi?: boolean;
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
- Find each company's website "domain" by searching its name (e.g. "<company>
  official website"). Only use null if you genuinely cannot determine it. A bare
  host like "acme.com" — no https://, no path.
- Prefer a real "full_name" for each contact. If a source names only a role
  (e.g. "Office Manager"), search for the person in that role; only leave
  full_name null, with confidence "low", if you cannot find the name.
- For each named contact, find their LinkedIn profile URL by searching their
  name plus the company (e.g. "Jane Doe Acme LinkedIn") and set "linkedin_url".
  Use null only if you genuinely cannot find their profile.
- Output the JSON object and nothing else.`;

// Concrete, highest-yield ways to find an MSP's customers (and resolve
// anonymized references). Appended to the customer-finding modes.
const METHODS = `Where to look (highest-yield first):
- The MSP's own site: case studies, testimonials, and "our clients" pages. Also
  check indexed PDFs (site:<mspdomain> filetype:pdf) and the client logo wall —
  read each logo's alt text, image filename, and link target to name the company.
- Verified review sites: Clutch (lists the reviewer's company, industry, size),
  plus G2, UpCity, TechBehemoths, GoodFirms, FeaturedCustomers, Google reviews.
- Web-wide co-mentions via search operators: "<MSP>" (client OR customer OR
  "partnered with"); "<MSP>" -site:<mspdomain> for third-party and news mentions;
  intext:"<MSP>" filetype:pdf.
- LinkedIn win/onboarding posts: site:linkedin.com/posts "<MSP>" (welcome OR
  "new client" OR onboarded), and press releases, local business-journal news,
  and award announcements naming the MSP.
- If a source only gives an anonymized reference (e.g. "the IT Director at a
  Richmond law firm"), resolve it: combine the clues (industry + city + title +
  first name) and search LinkedIn / company sites to name the real company and
  person. Only assert a match with two or more corroborating clues; otherwise
  omit it or set confidence "low".
A co-mention does not prove a client relationship — verify intent before
including a company, and set confidence to match the strength of the evidence.`;

// The do-not-research instruction. Present only when there is something to
// exclude, so an empty list never ships a dangling header (and a first run,
// which has nothing to exclude, keeps its original prompt shape and version).
// The list itself is volatile config and lives behind {{known}}.
const EXCLUSIONS = `Already in our database — do NOT return any of these, and do not spend search
effort re-researching them. They are listed so your budget goes to companies we
do not already have. If a strong candidate is on the list, skip it and find
another; a shorter honest list of NEW companies beats a padded one.
{{known}}`;

// Same instruction, scoped per MSP: a company we already know as MSP A's client
// is still a new find under MSP B, so exclusion is by (company, MSP) pair.
const EXCLUSIONS_PER_MSP = `Clients we already have on file for these MSPs — do NOT return them again for
the same MSP, and do not spend search effort re-confirming them. Finding one of
these companies as a client of a DIFFERENT MSP below is still new and worth
returning.
{{known}}`;

// Runner variant of the exclusion instruction. Nothing is embedded: the agent
// shortlists cheaply, asks the API which candidates are new, and spends the
// expensive per-company research only on those. This is what removes the cap —
// the list the prompt carries becomes an INCLUSION list bounded by how many
// results were requested, rather than an exclusion list that grows with the
// database.
const CHECK_VIA_API = `Do NOT research companies we already have. You have an API for this — use it
instead of guessing:

1. SHORTLIST first, cheaply. Produce a wide list of candidate company names
   (with a domain where you already know it) that fit the brief. Do not verify
   them, do not look for contacts, do not open each site yet. Aim for roughly
   3x the number of results requested, because many will already be known.
2. CHECK them: POST the candidates to /api/sourcing/known. It answers which are
   already in the database and which are new. It compares against EVERY
   organization we hold — there is no cap and no truncation, so its answer is
   authoritative. Never skip this step to save a call.
3. RESEARCH only the ones it returns as new, and only up to the number
   requested. This is where the real work goes: verify the company, establish
   the MSP relationship, find the contact, and collect a source URL for each.
4. If step 3 leaves you short of the requested count, go back to step 1 with a
   different angle (a different city, industry, or source type) rather than
   padding with companies you could not verify.

Report how many candidates you shortlisted, how many were already known, and
how many you researched.`;

// The template is the static instruction portion of the prompt: volatile config
// values become {{placeholders}}. Mode-dependent text (and the optional profile
// line) stays in the template, so different shapes hash to different
// prompt_versions — which is honest; mode is recorded in the run config.
export function buildTemplateText(params: PromptParams): string {
  const profile = params.profile?.trim();
  const viaApi = !!params.checkKnownViaApi;
  const hasKnown = !viaApi && !!params.known?.length;

  if (params.mode === "research_msps") {
    return [
      `You are sourcing managed IT service providers (MSPs) as potential acquisition targets.`,
      `Find up to {{count}} real MSPs based in {{region}}.`,
      profile ? `Target profile: {{targetProfile}}.` : "",
      `For each MSP, set "current_msp_name" to null and leave "contacts" as an empty array unless a leader is clearly named. Every organization you return is an MSP.`,
      "",
      viaApi ? CHECK_VIA_API : hasKnown ? EXCLUSIONS : "",
      CONTRACT,
      "",
      RULES,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (params.mode === "research_customers") {
    return [
      `You are sourcing companies that USE a managed IT service provider (an MSP), so we can study the MSP market.`,
      `Find up to {{count}} real companies based in {{region}} that outsource their IT to an MSP.`,
      profile ? `Target profile: {{targetProfile}}.` : "",
      `For each company, estimate "current_msp_name" (the MSP they use) when you can find evidence, and set its "confidence" accordingly. Identify a contact who is the owner/decision-maker ("owner") or who leads IT ("head_of_it") when findable. Every organization you return is a customer (not an MSP).`,
      "",
      viaApi ? CHECK_VIA_API : hasKnown ? EXCLUSIONS : "",
      METHODS,
      "",
      CONTRACT,
      "",
      RULES,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // find_customers_for_msps
  return [
    `You are finding the CUSTOMERS of specific managed IT service providers (MSPs), so we can study how their clients work with them.`,
    `For each MSP listed below, find up to {{count}} real companies that are its clients.`,
    profile ? `Prefer customers matching: {{targetProfile}}.` : "",
    `Set each customer's "current_msp_name" to the EXACT MSP name from this list it belongs to. Set "confidence" by how clearly that client relationship is documented. Identify an owner/decision-maker ("owner") or IT lead ("head_of_it") contact when findable. Every organization you return is a customer.`,
    "",
    `MSPs:`,
    `{{mspList}}`,
    "",
    viaApi ? CHECK_VIA_API : hasKnown ? EXCLUSIONS_PER_MSP : "",
    METHODS,
    "",
    CONTRACT,
    "",
    RULES,
  ]
    .filter(Boolean)
    .join("\n");
}

// Function replacement so config values are inserted literally ($ is not
// special) and never re-scanned for placeholders.
const substitute = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);

const orgLine = (o: KnownOrg): string => `- ${o.name}${o.domain ? ` (${o.domain})` : ""}`;

// Renders the do-not-research list. Flat for the two research modes; grouped by
// MSP for find_customers_for_msps, where exclusion is per (company, MSP).
// knownOmitted is stated rather than hidden: the list is capped to keep the
// prompt workable, and a silently truncated exclusion list would read as "this
// is everything we have" when it isn't.
function buildKnownList(params: PromptParams): string {
  const known = params.known ?? [];
  if (!known.length) return "";

  let body: string;
  if (params.mode === "find_customers_for_msps") {
    const byMsp = new Map<string, KnownOrg[]>();
    for (const o of known) {
      const key = o.mspName?.trim() || "(MSP not recorded)";
      const arr = byMsp.get(key) ?? [];
      arr.push(o);
      byMsp.set(key, arr);
    }
    body = [...byMsp.entries()]
      .map(([msp, orgs]) => [`${msp}:`, ...orgs.map((o) => `  ${orgLine(o)}`)].join("\n"))
      .join("\n");
  } else {
    body = known.map(orgLine).join("\n");
  }

  const omitted = params.knownOmitted ?? 0;
  return omitted > 0
    ? `${body}\n(…plus ${omitted} more we already have, not listed here. Treat any company that looks well-covered as likely already known.)`
    : body;
}

export function buildPrompt(params: PromptParams): string {
  const region = params.region?.trim() || "the United States";
  const profile = params.profile?.trim() ?? "";
  const count =
    params.mode === "find_customers_for_msps"
      ? params.countPer ?? 10
      : params.count ?? 25;
  const msps = (params.msps ?? []).filter((m) => m.name?.trim());
  const mspList = msps.length
    ? msps
        .map((m) => `- ${m.name}${m.domain ? ` (${m.domain})` : ""}`)
        .join("\n")
    : "- (no MSPs provided)";
  return substitute(buildTemplateText(params), {
    region,
    count: String(count),
    targetProfile: profile,
    mspList,
    known: buildKnownList(params),
  });
}
