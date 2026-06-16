import { z } from "zod";
import { isSampled } from "../grading/math";
import type { RunModule, IngestContext, IngestOutcome } from "./types";

// Enrichment as a pipeline module — a copy-paste fallback/complement to the Clay
// webhook. Given a list of contacts, the model returns verified contact details
// (email / phone / linkedin) with a source URL. ingest fills only NULL fields
// (never overwrites a value Clay already found) and gates on evidence.

const optStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().nullish(),
);

export const EnrichmentPayloadSchema = z.object({
  enrichments: z
    .array(
      z.object({
        contact_id: z.string().min(1, "contact_id required"),
        email: optStr,
        phone: optStr,
        linkedin_url: optStr,
        source_url: optStr,
        confidence: z.enum(["high", "medium", "low"]).catch("low").default("low"),
      }),
    )
    .min(1, "no enrichments"),
});

export type EnrichmentPayload = z.infer<typeof EnrichmentPayloadSchema>;

export type EnrichmentContact = {
  contact_id: string;
  full_name: string | null;
  company_name: string;
  company_domain: string | null;
  linkedin_url: string | null;
};

export type EnrichmentConfig = { contacts: EnrichmentContact[] };

export const enrichmentModule: RunModule<EnrichmentConfig, EnrichmentPayload> = {
  key: "enrichment",
  label: "enriched contacts",

  renderPrompt(_template, config) {
    const lines = (config.contacts ?? []).map((c, i) => {
      const company = c.company_domain ? `${c.company_name} (${c.company_domain})` : c.company_name;
      const parts = [
        `[${i + 1}] contact_id=${c.contact_id}`,
        `name=${c.full_name ?? "unknown"}`,
        `company=${company}`,
        c.linkedin_url ? `linkedin=${c.linkedin_url}` : "",
      ].filter(Boolean);
      return parts.join("; ");
    });
    return [
      `You are finding verified business contact details. For EACH person below, use web search to find their work email, direct phone, and LinkedIn profile URL at the named company.`,
      ``,
      `Rules:`,
      `- Only return a value you can verify from a citable source. Never guess an email pattern; if you cannot confirm it, leave it null.`,
      `- Always include a "source_url" backing the details. A row with no source_url is dropped at ingest.`,
      `- Use the exact contact_id from each line.`,
      ``,
      `Return ONLY this JSON: { "enrichments": [ { "contact_id": string, "email": string|null, "phone": string|null, "linkedin_url": string|null, "source_url": string|null, "confidence": "high"|"medium"|"low" } ] }`,
      ``,
      `Contacts:`,
      lines.join("\n"),
    ].join("\n");
  },

  parse(rawText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: "That is not valid JSON. Paste the full JSON object the model returned." };
    }
    const result = EnrichmentPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, error: `Validation failed — ${issues.join("; ")}` };
    }
    return { ok: true, data: result.data };
  },

  async ingest(supabase, output, ctx: IngestContext): Promise<IngestOutcome> {
    let inserted = 0;
    let rejected = 0;
    let sampledCount = 0;
    const messages: string[] = [];
    const rejects: { run_id: string | null; payload: unknown; reason: string }[] = [];

    for (const e of output.enrichments) {
      if (ctx.requireEvidence && !(e.source_url && e.source_url.trim())) {
        rejected++;
        rejects.push({ run_id: ctx.runId, payload: e, reason: "enrichment has no source_url (evidence)" });
        continue;
      }
      // Fill only NULL fields. Read current values first.
      const { data: existing } = await supabase
        .from("contacts")
        .select("id, email, phone, linkedin_url")
        .eq("id", e.contact_id)
        .maybeSingle();
      if (!existing) {
        messages.push(`unknown contact_id ${e.contact_id}`);
        continue;
      }
      const patch: Record<string, unknown> = {};
      if (!existing.email && e.email) patch.email = e.email;
      if (!existing.phone && e.phone) patch.phone = e.phone;
      if (!existing.linkedin_url && e.linkedin_url) patch.linkedin_url = e.linkedin_url;
      const hasAny = existing.email || existing.phone || patch.email || patch.phone;
      patch.enrichment_status = hasAny ? "enriched" : "low_confidence";
      patch.stage = "enriched";
      if (e.source_url) patch.evidence = [{ url: e.source_url.trim(), via: "enrichment" }];
      if (ctx.batchId) patch.batch_id = ctx.batchId;
      const sampled = ctx.sampleRate >= 1 ? true : isSampled(e.contact_id, ctx.sampleRate);
      patch.sampled = sampled;
      patch.review_status = sampled ? "pending_review" : "skipped_sampling";
      if (sampled) sampledCount++;

      const { error } = await supabase.from("contacts").update(patch).eq("id", e.contact_id);
      if (error) messages.push(`update ${e.contact_id}: ${error.message}`);
      else inserted++;
    }

    if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
    return {
      ok: true,
      inserted,
      rejected,
      sampledCount,
      messages: [`${inserted} contact(s) enriched; ${rejected} dropped for missing evidence.`, ...messages],
    };
  },
};
