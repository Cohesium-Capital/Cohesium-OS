import { z } from "zod";
import { isSampled } from "../grading/math";
import type { RunModule, IngestContext, IngestOutcome } from "./types";

// Personalization as a pipeline module: research ONE true, recent, verifiable
// hook per contact (the angle the drafter then uses). Stored on
// contacts.personalization with its evidence; evidence-gated and sampled so the
// hooks can be graded before drafting consumes them.

const optStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().nullish(),
);

export const PersonalizationPayloadSchema = z.object({
  personalizations: z
    .array(
      z.object({
        contact_id: z.string().min(1, "contact_id required"),
        note: z.string().trim().min(1, "note required"),
        source_url: optStr,
      }),
    )
    .min(1, "no personalizations"),
});

export type PersonalizationPayload = z.infer<typeof PersonalizationPayloadSchema>;

export type PersonalizationContact = {
  contact_id: string;
  full_name: string | null;
  title: string | null;
  company_name: string;
  company_domain: string | null;
  current_msp: string | null;
};

export type PersonalizationConfig = { contacts: PersonalizationContact[] };

export const personalizationModule: RunModule<PersonalizationConfig, PersonalizationPayload> = {
  key: "personalization",
  label: "personalization hooks",

  renderPrompt(_template, config) {
    const lines = (config.contacts ?? []).map((c, i) => {
      const company = c.company_domain ? `${c.company_name} (${c.company_domain})` : c.company_name;
      const parts = [
        `[${i + 1}] contact_id=${c.contact_id}`,
        `name=${c.full_name ?? "unknown"}`,
        c.title ? `title=${c.title}` : "",
        `company=${company}`,
        c.current_msp ? `current_msp=${c.current_msp}` : "",
      ].filter(Boolean);
      return parts.join("; ");
    });
    return [
      `For EACH person below, find ONE true, specific, verifiable detail to open a warm outreach with — strongly prefer something from the LAST 12 MONTHS (a recent talk, panel, podcast, conference appearance, company announcement, or post).`,
      ``,
      `Rules:`,
      `- VERIFY the detail with web search. Only state a fact you can confirm from a citable source. If you cannot verify a recent specific detail, write a neutral, honest observation about their role/industry and set source_url to null.`,
      `- The "note" is one or two sentences of the hook itself, not a full email.`,
      `- Include a "source_url" for any specific claim. Use the exact contact_id from each line.`,
      ``,
      `Return ONLY this JSON: { "personalizations": [ { "contact_id": string, "note": string, "source_url": string|null } ] }`,
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
    const result = PersonalizationPayloadSchema.safeParse(parsed);
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

    for (const p of output.personalizations) {
      if (ctx.requireEvidence && !(p.source_url && p.source_url.trim())) {
        rejected++;
        rejects.push({ run_id: ctx.runId, payload: p, reason: "personalization has no source_url (evidence)" });
        continue;
      }
      const patch: Record<string, unknown> = { personalization: p.note };
      if (p.source_url) patch.evidence = [{ url: p.source_url.trim(), via: "personalization" }];
      if (ctx.batchId) patch.batch_id = ctx.batchId;
      const sampled = ctx.sampleRate >= 1 ? true : isSampled(p.contact_id, ctx.sampleRate);
      patch.sampled = sampled;
      patch.review_status = sampled ? "pending_review" : "skipped_sampling";
      if (sampled) sampledCount++;

      const { error } = await supabase.from("contacts").update(patch).eq("id", p.contact_id);
      if (error) messages.push(`update ${p.contact_id}: ${error.message}`);
      else inserted++;
    }

    if (rejects.length) await supabase.from("rejected_ingest").insert(rejects);
    return {
      ok: true,
      inserted,
      rejected,
      sampledCount,
      messages: [`${inserted} hook(s) written; ${rejected} dropped for missing evidence.`, ...messages],
    };
  },
};
