// Builds the research prompt you paste into Claude/ChatGPT (with web search on).
// The model returns JSON matching the contract in lib/contracts.ts, which you
// paste back into the importer. Keeping the heavy research on your subscription
// instead of the metered API is the project's cost lever.

import {
  DEFAULT_PROFILE,
  type WorkspaceProfile,
  type WorkspaceVocab,
} from "../workspace/identity";

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
  /**
   * Rules learned from graded mistakes and review deletions (migration 025),
   * rendered by prepareConfig so they are part of the hashed template.
   */
  learnedRules?: string;
  /**
   * The workspace's identity and market vocabulary. Loaded by prepareConfig, so
   * — like learnedRules — it is part of the hashed template: a firm that renames
   * its market gets a new prompt_version rather than silently changing the
   * meaning of the old one's error rate. Defaults to Cohesium's values.
   *
   * Named `workspace`, not `profile`: `profile` above is the TARGET company
   * profile ("10-200 employees, professional services") and has been since the
   * first version of this file.
   */
  workspace?: WorkspaceProfile;
};

const vocabOf = (params: PromptParams): WorkspaceVocab =>
  (params.workspace ?? DEFAULT_PROFILE).vocab;

const contractText = (v: WorkspaceVocab) => `Return ONLY a single JSON object. No markdown, no code fences, no commentary
before or after it. The object must match this shape exactly:

{
  "organizations": [
    {
      "name": string,                     // the company's name
      "domain": string | null,            // primary website host, e.g. "acme.com" (no https://, no path)
      "hq_city": string | null,
      "hq_state": string | null,          // 2-letter state/province code where applicable
      "current_msp_name": string | null,  // the ${v.providerGeneric} this company uses, if known/estimated
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

const rulesText = (v: WorkspaceVocab) => `Rules:
- Use web search to ground every row. Do NOT invent a company, person, domain,
  or ${v.providerAbbrev} relationship. A fabricated row poisons the dataset, which is the asset
  being built. An honest omission is always better than a confident guess.
- For anything not verifiable, use null and set "confidence" to "low".
- "confidence" reflects how sure you are that the entity is real AND that the
  stated relationship (e.g. which ${v.providerAbbrev} they use) is true. Reserve "high" for
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
const methodsText = (v: WorkspaceVocab) => `Where to look (highest-yield first):
- The ${v.providerAbbrev}'s own site: case studies, testimonials, and "our clients" pages. Also
  check indexed PDFs (site:<${v.providerAbbrev.toLowerCase()}domain> filetype:pdf) and the client logo wall —
  read each logo's alt text, image filename, and link target to name the company.
- Verified review sites: Clutch (lists the reviewer's company, industry, size),
  plus G2, UpCity, TechBehemoths, GoodFirms, FeaturedCustomers, Google reviews.
- Web-wide co-mentions via search operators: "<${v.providerAbbrev}>" (client OR customer OR
  "partnered with"); "<${v.providerAbbrev}>" -site:<${v.providerAbbrev.toLowerCase()}domain> for third-party and news mentions;
  intext:"<${v.providerAbbrev}>" filetype:pdf.
- LinkedIn win/onboarding posts: site:linkedin.com/posts "<${v.providerAbbrev}>" (welcome OR
  "new client" OR onboarded), and press releases, local business-journal news,
  and award announcements naming the ${v.providerAbbrev}.
- If a source only gives an anonymized reference (e.g. "the IT Director at a
  Richmond law firm"), resolve it: combine the clues (industry + city + title +
  first name) and search LinkedIn / company sites to name the real company and
  person. Only assert a match with two or more corroborating clues; otherwise
  omit it or set confidence "low".
A co-mention does not prove a client relationship — verify intent before
including a company, and set confidence to match the strength of the evidence.`;

// research_customers qualifies on profile + geography. Naming the company's MSP
// is valuable but optional: requiring it made the model discard good companies
// whose provider simply is not documented anywhere, which is most of them. It
// stays a bonus field, and the honest null is explicitly allowed.
const providerLinkOptional = (v: WorkspaceVocab) =>
  `If you can find evidence of which ${v.providerAbbrev} a company uses, set "current_msp_name"
and let "confidence" reflect how well documented that link is. If you cannot,
set "current_msp_name" to null and still return the company — an unknown
provider is NOT a reason to drop a company that fits the profile, and a guessed
provider is worse than null. Do not spend the bulk of your search budget
chasing provider relationships; spend it on finding qualified companies and a
named contact at each.`;

// The provider-relationship methods, offered as an optional bonus pass for
// research_customers rather than the mode's main job.
const providerLinkMethods = (v: WorkspaceVocab) =>
  `If you want to try to identify a company's IT provider (optional, only when it
is cheap to do), these are the highest-yield places: the ${v.providerAbbrev}'s own case
studies, testimonials, and client logo walls; review sites like Clutch, G2,
UpCity and TechBehemoths that name the reviewer's company; web-wide
co-mentions ("<company>" with client OR "partnered with"); and LinkedIn
onboarding or win posts. A co-mention does not prove a relationship — if the
evidence is thin, leave "current_msp_name" null rather than guessing.`;

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
const exclusionsPerProvider = (v: WorkspaceVocab) =>
  `Clients we already have on file for these ${v.providerAbbrevPlural} — do NOT return them again for
the same ${v.providerAbbrev}, and do not spend search effort re-confirming them. Finding one of
these companies as a client of a DIFFERENT ${v.providerAbbrev} below is still new and worth
returning.
{{known}}`;

// Runner variant of the exclusion instruction. Nothing is embedded: the agent
// shortlists cheaply, asks the API which candidates are new, and spends the
// expensive per-company research only on those. This is what removes the cap —
// the list the prompt carries becomes an INCLUSION list bounded by how many
// results were requested, rather than an exclusion list that grows with the
// database.
const checkViaApiText = (v: WorkspaceVocab) => `Do NOT research companies we already have. You have an API for this — use it
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
   the ${v.providerAbbrev} relationship, find the contact, and collect a source URL for each.
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
  const v = vocabOf(params);

  if (params.mode === "research_msps") {
    return [
      `You are sourcing ${v.providerPlural} (${v.providerAbbrevPlural}) as potential acquisition targets.`,
      `Find up to {{count}} real ${v.providerAbbrevPlural} based in {{region}}.`,
      profile ? `Target profile: {{targetProfile}}.` : "",
      `For each ${v.providerAbbrev}, set "current_msp_name" to null and leave "contacts" as an empty array unless a leader is clearly named. Every organization you return is an ${v.providerAbbrev}.`,
      "",
      viaApi ? checkViaApiText(v) : hasKnown ? EXCLUSIONS : "",
      contractText(v),
      "",
      rulesText(v),
      params.learnedRules ? `\n${params.learnedRules}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (params.mode === "research_customers") {
    return [
      `You are sourcing companies that fit our target profile in a specific geography, so we can study the ${v.market} and reach the people running these businesses.`,
      `Find up to {{count}} real companies based in {{region}}.`,
      profile ? `Target profile: {{targetProfile}}.` : "",
      `Qualification is profile fit and geography — nothing else. A company qualifies if it matches the profile above and is based in the region.`,
      providerLinkOptional(v),
      `Identify a contact at EVERY company you return: the owner/decision-maker ("owner") or the person who leads IT ("head_of_it"). A company with no contact is not usable, so put the search effort into finding a named person. Every organization you return is a customer (not an ${v.providerAbbrev}).`,
      "",
      viaApi ? checkViaApiText(v) : hasKnown ? EXCLUSIONS : "",
      providerLinkMethods(v),
      "",
      contractText(v),
      "",
      rulesText(v),
      params.learnedRules ? `\n${params.learnedRules}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // find_customers_for_msps
  return [
    `You are finding the CUSTOMERS of specific ${v.providerPlural} (${v.providerAbbrevPlural}), so we can study how their clients work with them.`,
    `For each ${v.providerAbbrev} listed below, find up to {{count}} real companies that are its clients.`,
    profile ? `Prefer customers matching: {{targetProfile}}.` : "",
    `Set each customer's "current_msp_name" to the EXACT ${v.providerAbbrev} name from this list it belongs to. Set "confidence" by how clearly that client relationship is documented. Identify an owner/decision-maker ("owner") or IT lead ("head_of_it") contact when findable. Every organization you return is a customer.`,
    "",
    `${v.providerAbbrevPlural}:`,
    `{{mspList}}`,
    "",
    viaApi ? checkViaApiText(v) : hasKnown ? exclusionsPerProvider(v) : "",
    methodsText(v),
    "",
    contractText(v),
    "",
    rulesText(v),
    params.learnedRules ? `\n${params.learnedRules}` : "",
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
      const key = o.mspName?.trim() || `(${vocabOf(params).providerAbbrev} not recorded)`;
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
    : `- (no ${vocabOf(params).providerAbbrevPlural} provided)`;
  return substitute(buildTemplateText(params), {
    region,
    count: String(count),
    targetProfile: profile,
    mspList,
    known: buildKnownList(params),
  });
}
