import type { SupabaseClient } from "@supabase/supabase-js";
import type { Draft } from "./contracts";
import { type DraftReport, EMPTY_DRAFT_REPORT } from "./types";

// Provenance stamped on every stored draft: which run and prompt version
// produced it. This is what lets reply outcomes be attributed back to the
// prompt that wrote the message (the learning loop's first edge).
export type DraftProvenance = {
  runId?: string | null;
  promptVersionId?: string | null;
};

// Resolve the active drafting prompt version, for callers that store drafts
// outside a run (the Draft page's paste flow, the headless workflow script).
export async function activeDraftPromptVersion(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data } = await supabase
    .from("prompt_versions")
    .select("id")
    .eq("module", "drafting")
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Client-agnostic draft storage. The web action calls it with a user-session
// client (RLS); the drafting workflow's headless store calls it with a
// service-role client. Writes each draft as a planned outbound touch, gated by
// the contact having an address, deduped per contact+channel.
export async function storeDrafts(
  supabase: SupabaseClient,
  drafts: Draft[],
  provenance: DraftProvenance = {},
): Promise<DraftReport> {
  const report: DraftReport = { ...EMPTY_DRAFT_REPORT, messages: [] };
  const ids = [...new Set(drafts.map((d) => d.contact_id))];
  if (!ids.length) {
    report.messages.push("No drafts to store.");
    return report;
  }

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
    // A LinkedIn note over the 300-char hard limit is a bad draft. Rather than
    // silently mangle it with an ellipsis, keep the full text and store it
    // UNAPPROVED so it surfaces in the queue and flows back into re-drafting.
    const body = d.body;
    const overLimit = d.channel === "linkedin" && body.length > 300;
    const approved = !overLimit;
    if (overLimit) report.flaggedOverLimit++;
    const subject = d.channel === "email" ? d.subject ?? null : null;

    const prov = {
      run_id: provenance.runId ?? null,
      prompt_version_id: provenance.promptVersionId ?? null,
    };

    const existingId = existingKey.get(`${d.contact_id}|${d.channel}`);
    if (existingId) {
      const { error } = await supabase
        .from("touches")
        .update({ subject, body, status: "planned", approved, ...prov })
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
        approved,
        ...prov,
      });
    }
  }

  if (inserts.length) {
    const { data, error } = await supabase.from("touches").insert(inserts).select("id");
    if (error) return { ...report, ok: false, error: `Insert failed: ${error.message}` };
    report.drafted = data?.length ?? 0;
  }
  if (!report.drafted && !report.updated) {
    report.messages.push("No drafts written — check contact_ids and that contacts have an address.");
  }
  if (report.flaggedOverLimit) {
    report.messages.push(
      `${report.flaggedOverLimit} LinkedIn draft(s) were over 300 characters — stored unapproved so you can re-draft them.`,
    );
  }
  return report;
}
