import { z } from "zod";

// The contract for sourcing data pasted back from Claude/ChatGPT (or imported
// from a CSV). Mirrors the organizations/contacts tables. This is the TypeScript
// analog of the Pydantic guard in extract.py: anything off-shape is rejected and
// surfaced for fixing, never silently inserted.

export const CONFIDENCE = ["high", "medium", "low"] as const;
export const PERSONA = ["owner", "head_of_it", "other"] as const;
export const ORG_KIND = ["msp", "customer"] as const;

export type Confidence = (typeof CONFIDENCE)[number];

// Optional string that treats "" / whitespace as null and trims otherwise.
const optStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().nullish(),
);

// Unknown/garbage values fall back rather than failing the whole row: an
// unexpected persona becomes "other", an unexpected confidence becomes "low"
// (conservative — it gets flagged).
const persona = z
  .enum(PERSONA)
  .catch("other")
  .default("other");
const confidence = z.enum(CONFIDENCE).catch("low").default("low");

export const SourcedContactSchema = z.object({
  full_name: optStr,
  persona,
  title: optStr,
  linkedin_url: optStr,
  source_url: optStr,
  confidence,
});

export const SourcedOrganizationSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  // Normalized in import (lowercase, strip protocol/path). Optional because
  // research does not always surface a domain; a missing domain is flagged.
  domain: optStr,
  // kind is authoritatively set from the import mode, not trusted from the
  // model, so it is optional here.
  kind: z.enum(ORG_KIND).nullish(),
  hq_city: optStr,
  hq_state: optStr,
  current_msp_name: optStr,
  source_url: optStr,
  confidence,
  contacts: z.array(SourcedContactSchema).default([]),
});

export const SourcingPayloadSchema = z.object({
  organizations: z.array(SourcedOrganizationSchema).min(1, "no organizations"),
});

export type SourcedContact = z.infer<typeof SourcedContactSchema>;
export type SourcedOrganization = z.infer<typeof SourcedOrganizationSchema>;
export type SourcingPayload = z.infer<typeof SourcingPayloadSchema>;

// Normalize a domain to a bare host: lowercase, no scheme, no path, no www.
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].trim();
  return d || null;
}

// Tokens that don't help identify a company — legal suffixes and stopwords.
// Dropped before building the comparison key so name variants collapse together.
const NAME_NOISE = new Set([
  "inc", "incorporated", "llc", "llp", "pllc", "lllp", "pc", "pa", "corp",
  "corporation", "co", "company", "ltd", "limited", "lp", "llp", "foundation",
  "group", "holdings", "na", "the", "and", "of", "a", "an",
]);

// Person-name suffixes/credentials to ignore when comparing contact names.
const NAME_SUFFIX = new Set([
  "jr", "sr", "ii", "iii", "iv", "v", "dmd", "dds", "md", "do", "phd", "esq",
  "cpa", "mba", "pe", "rn", "np", "pa", "pc",
]);

// Common nickname -> canonical first name, so "Rob"/"Robert" and "Joe"/"Joseph"
// match. Not exhaustive; covers the frequent cases.
const NICKNAMES: Record<string, string> = {
  rob: "robert", bob: "robert", bobby: "robert", robbie: "robert",
  joe: "joseph", joey: "joseph",
  bill: "william", will: "william", billy: "william",
  jim: "james", jimmy: "james", jamie: "james",
  mike: "michael", mick: "michael",
  dave: "david", tom: "thomas", tommy: "thomas",
  dan: "daniel", danny: "daniel",
  chris: "christopher", matt: "matthew",
  rick: "richard", rich: "richard", dick: "richard",
  steve: "stephen", chuck: "charles", charlie: "charles",
  ed: "edward", eddie: "edward",
  tony: "anthony", nick: "nicholas", sam: "samuel",
  ben: "benjamin", greg: "gregory", jeff: "jeffrey",
  ken: "kenneth", andy: "andrew", drew: "andrew",
  liz: "elizabeth", beth: "elizabeth", betty: "elizabeth",
  kate: "katherine", katie: "katherine", maggie: "margaret",
};

function personTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_SUFFIX.has(t));
}

// True if two contact names likely refer to the same person: same surname AND a
// matching first name (exact, prefix like rob/robert, or a known nickname like
// joe/joseph). Used to dedupe contacts within an organization.
export function contactNameMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ta = personTokens(a);
  const tb = personTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false; // surnames differ
  const fa = ta[0];
  const fb = tb[0];
  if (fa === fb) return true;
  if (fa.startsWith(fb) || fb.startsWith(fa)) return true;
  return (NICKNAMES[fa] ?? fa) === (NICKNAMES[fb] ?? fb);
}

// Collapse a company name to a comparison key for deduping. Lowercase, drop
// parentheticals, strip punctuation, and remove legal-suffix/stopword tokens so
// "Virginia Horse Center", "Virginia Horse Center Foundation", and
// "PBI Performance Products, Inc." all reduce to a stable key.
export function nameKey(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // drop parentheticals
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .split(/\s+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .join("");
}
