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
