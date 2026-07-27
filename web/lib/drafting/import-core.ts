import type { SupabaseClient } from "@supabase/supabase-js";
import type { Draft } from "./contracts";
import type { TrackKind } from "./prompt";
import { type DraftReport, EMPTY_DRAFT_REPORT } from "./types";

// Provenance stamped on every stored draft: which run and prompt version
// produced it, and which audience track it speaks to. This is what lets reply
// outcomes be attributed back to the prompt that wrote the message, per track
// (the learning loop's first edge).
export type DraftProvenance = {
  runId?: string | null;
  promptVersionId?: string | null;
  track?: TrackKind | null;
};

// Resolve the active drafting prompt version, for callers that store drafts
// outside a run (the headless workflow script).
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

// Client-agnostic draft storage. The run lifecycle calls it with a user-session
// client (RLS); the drafting workflow's headless store calls it with a
// service-role client. Writes each draft as a planned outbound touch, gated by
// the contact having an address, deduped per contact+channel against live
// PLANNED drafts only (queued/sent/replied touches are send records and are
// never touched). Every draft lands UNAPPROVED: approval is an explicit human
// act in the send queue, never a side effect of generation.
//
// hookIds maps contact_id → the hook the draft consumed; it stamps
// touches.hook_id on both write paths. That stamp is the ONLY usage record —
// hooks.status is never flipped to 'used' (the hook_outcomes rent check
// derives usage from touches.hook_id).
export async function storeDrafts(
  supabase: SupabaseClient,
  drafts: Draft[],
  provenance: DraftProvenance = {},
  hookIds: Record<string, string> = {},
  // The workspace these touches belong to, from the run that produced them.
  workspaceId?: string,
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
    .in("id", ids)
    .is("deleted_at", null);
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));

  // Dedupe against live PLANNED drafts only. A touch that is already queued,
  // sent, delivered, replied, or bounced is a send record, not a draft — it must
  // never be overwritten or flipped back to planned (that would corrupt the send
  // history and re-send the contact). A contact like that simply gets a fresh
  // planned touch, which re-enters the approval queue as a new draft.
  const { data: existing } = await supabase
    .from("touches")
    .select("id, contact_id, channel, subject, body")
    .in("contact_id", ids)
    .eq("sequence_step", 1)
    .eq("direction", "outbound")
    .eq("status", "planned")
    .is("deleted_at", null);
  const existingKey = new Map(
    (existing ?? []).map((t) => [`${t.contact_id}|${t.channel}`, t]),
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
    // silently mangle it with an ellipsis, keep the full text and flag it so it
    // gets re-drafted instead of approved.
    const body = d.body;
    if (d.channel === "linkedin" && body.length > 300) report.flaggedOverLimit++;
    const subject = d.channel === "email" ? d.subject ?? null : null;

    const prov = {
      run_id: provenance.runId ?? null,
      prompt_version_id: provenance.promptVersionId ?? null,
      track: provenance.track ?? null,
      // Applies to the update path too: a re-draft carries whatever hook its
      // new copy consumed (or null, honestly landing it in the no-hook arm).
      hook_id: hookIds[d.contact_id] ?? null,
    };

    const prev = existingKey.get(`${d.contact_id}|${d.channel}`);
    if (prev) {
      // Re-draft: the rejected copy is a negative example — snapshot it to
      // touch_edits before overwriting, so the loop keeps what got replaced.
      const edits: { touch_id: string; field: string; previous_value: string | null; new_value: string | null; editor: string }[] = [];
      if ((prev.subject ?? null) !== subject) {
        edits.push({ touch_id: prev.id, field: "subject", previous_value: prev.subject, new_value: subject, editor: "redraft" });
      }
      if (prev.body !== body) {
        edits.push({ touch_id: prev.id, field: "body", previous_value: prev.body, new_value: body, editor: "redraft" });
      }
      if (edits.length) {
        const { error: logError } = await supabase.from("touch_edits").insert(edits);
        if (logError) report.messages.push(`edit log ${d.contact_id}/${d.channel}: ${logError.message}`);
      }
      // New copy means any prior approval no longer applies — reset it.
      const { error } = await supabase
        .from("touches")
        .update({
          subject,
          body,
          status: "planned",
          approved: false,
          approved_by: null,
          approved_at: null,
          ...prov,
        })
        .eq("id", prev.id);
      if (error) report.messages.push(`update ${d.contact_id}/${d.channel}: ${error.message}`);
      else report.updated++;
    } else {
      inserts.push({
        contact_id: d.contact_id,
    workspace_id: workspaceId,
        channel: d.channel,
        direction: "outbound",
        sequence_step: 1,
        status: "planned",
        subject,
        body,
        approved: false,
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
      `${report.flaggedOverLimit} LinkedIn draft(s) were over 300 characters — re-draft them before approving.`,
    );
  }
  return report;
}
