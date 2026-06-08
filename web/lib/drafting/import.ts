"use server";

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { DraftsPayloadSchema } from "./contracts";
import { type DraftReport, EMPTY_DRAFT_REPORT } from "./types";

function fail(error: string): DraftReport {
  return { ...EMPTY_DRAFT_REPORT, ok: false, error };
}

// Validate pasted drafts and write them as planned outbound touches. A channel
// is skipped if the contact has no address for it (enrichment gates drafting),
// and re-importing a contact/channel updates its draft rather than duplicating.
export async function importDrafts(rawText: string): Promise<DraftReport> {
  await requireUser();
  const supabase = await createClient();
  const report: DraftReport = { ...EMPTY_DRAFT_REPORT, messages: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail("That is not valid JSON. Paste the full JSON object the model returned.");
  }
  const result = DraftsPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return fail(`Validation failed — ${issues.join("; ")}`);
  }
  const drafts = result.data.drafts;
  const ids = [...new Set(drafts.map((d) => d.contact_id))];

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, email, linkedin_url")
    .in("id", ids);
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));

  const { data: existing } = await supabase
    .from("touches")
    .select("id, contact_id, channel")
    .in("contact_id", ids)
    .eq("sequence_step", 1)
    .eq("direction", "outbound");
  const existingKey = new Map(
    (existing ?? []).map((t) => [`${t.contact_id}|${t.channel}`, t.id as string]),
  );

  const inserts: Record<string, unknown>[] = [];
  for (const d of drafts) {
    const c = byId.get(d.contact_id);
    if (!c) {
      report.skippedUnknown++;
      continue;
    }
    const hasAddress = d.channel === "email" ? !!c.email : !!c.linkedin_url;
    if (!hasAddress) {
      report.skippedNoAddress++;
      continue;
    }
    let body = d.body;
    if (d.channel === "linkedin" && body.length > 300) {
      body = body.slice(0, 297).trimEnd() + "...";
    }
    const subject = d.channel === "email" ? d.subject ?? null : null;

    const existingId = existingKey.get(`${d.contact_id}|${d.channel}`);
    if (existingId) {
      const { error } = await supabase
        .from("touches")
        .update({ subject, body, status: "planned", approved: true })
        .eq("id", existingId);
      if (error) report.messages.push(`update ${d.contact_id}/${d.channel}: ${error.message}`);
      else report.updated++;
    } else {
      inserts.push({
        contact_id: d.contact_id,
        channel: d.channel,
        direction: "outbound",
        sequence_step: 1,
        status: "planned",
        subject,
        body,
        approved: true,
      });
    }
  }

  if (inserts.length) {
    const { data, error } = await supabase.from("touches").insert(inserts).select("id");
    if (error) return fail(`Insert failed: ${error.message}`);
    report.drafted = data?.length ?? 0;
  }
  if (!report.drafted && !report.updated) {
    report.messages.push("No drafts written — check contact_ids and that contacts have an address.");
  }
  return report;
}
