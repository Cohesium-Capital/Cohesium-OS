import type { SupabaseClient } from "@supabase/supabase-js";

// Signal collection: every human correction, normalized into one row shape.
//
// The premise of the loop is that the founder's attention is the scarcest input
// in the system, and today it evaporates. Someone rewrites a draft's opener,
// rejects a hook as generic, or deletes a sourced company — the record survives,
// but the LESSON dies there and the same prompt produces the same mistake next
// run. Collection is what makes that lesson addressable.
//
// Idempotent by construction: every signal carries (ref_table, ref_id, kind),
// which is a unique key, so re-running collection can never double-count a
// correction into a rule's support.

export type LearningModule = "sourcing" | "enrichment" | "personalization" | "drafting";

export type SignalKind =
  | "draft_edit"
  | "draft_redraft"
  | "hook_reject"
  | "grade_correction"
  | "contact_delete";

export type LearningSignal = {
  module: LearningModule;
  kind: SignalKind;
  scope: Record<string, unknown>;
  before_text: string | null;
  after_text: string | null;
  category: string | null;
  ref_table: string;
  ref_id: string;
  run_id?: string | null;
  prompt_version_id?: string | null;
  occurred_at: string;
};

// Long fields are truncated before they ever reach the analyzer: a diff's
// lesson lives in its first paragraph, and whole message bodies would crowd out
// the other signals in the batch.
const EXCERPT = 600;
const excerpt = (v: string | null | undefined): string | null =>
  v == null ? null : v.length > EXCERPT ? `${v.slice(0, EXCERPT)}…` : v;

/** How far back a collection pass looks when nothing has been collected yet. */
const LOOKBACK_DAYS = 30;

function since(days = LOOKBACK_DAYS): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Human edits to drafted messages — the strongest signal the system has. The
 * operator read the draft, disagreed, and wrote what it should have said. The
 * before/after pair is exactly the lesson.
 */
async function collectDraftEdits(supabase: SupabaseClient): Promise<LearningSignal[]> {
  const { data } = await supabase
    .from("touch_edits")
    .select(
      "id, field, previous_value, new_value, created_at, touches(channel, track, prompt_version_id, run_id)",
    )
    .gte("created_at", since())
    .order("created_at", { ascending: false })
    .limit(200);

  return ((data ?? []) as unknown as {
    id: string;
    field: string;
    previous_value: string | null;
    new_value: string | null;
    created_at: string;
    touches: {
      channel: string | null;
      track: string | null;
      prompt_version_id: string | null;
      run_id: string | null;
    } | null;
  }[])
    // An edit that changed nothing teaches nothing.
    .filter((e) => (e.previous_value ?? "") !== (e.new_value ?? ""))
    .map((e) => ({
      module: "drafting" as const,
      kind: "draft_edit" as const,
      scope: {
        channel: e.touches?.channel ?? null,
        track: e.touches?.track ?? null,
        field: e.field,
      },
      before_text: excerpt(e.previous_value),
      after_text: excerpt(e.new_value),
      category: e.field,
      ref_table: "touch_edits",
      ref_id: e.id,
      run_id: e.touches?.run_id ?? null,
      prompt_version_id: e.touches?.prompt_version_id ?? null,
      occurred_at: e.created_at,
    }));
}

/**
 * Drafts sent back to drafting. Weaker than an edit — it says "wrong" without
 * saying what right looks like — but a cluster of them on one channel is still
 * a signal, and the delete_reason sometimes carries the why.
 */
async function collectRedrafts(supabase: SupabaseClient): Promise<LearningSignal[]> {
  const { data } = await supabase
    .from("touches")
    .select("id, channel, track, body, delete_reason, deleted_at, prompt_version_id, run_id")
    .not("deleted_at", "is", null)
    .eq("delete_reason", "redraft")
    .gte("deleted_at", since())
    .limit(100);

  return ((data ?? []) as unknown as {
    id: string;
    channel: string | null;
    track: string | null;
    body: string | null;
    deleted_at: string;
    prompt_version_id: string | null;
    run_id: string | null;
  }[]).map((t) => ({
    module: "drafting" as const,
    kind: "draft_redraft" as const,
    scope: { channel: t.channel, track: t.track },
    before_text: excerpt(t.body),
    after_text: null,
    category: "redraft",
    ref_table: "touches",
    ref_id: t.id,
    run_id: t.run_id,
    prompt_version_id: t.prompt_version_id,
    occurred_at: t.deleted_at,
  }));
}

/**
 * Rejected hooks, with the category the verifier chose. 'generic' and
 * 'hallucinated' are the two the personalization prompt can actually act on.
 */
async function collectHookRejects(supabase: SupabaseClient): Promise<LearningSignal[]> {
  const { data } = await supabase
    .from("hooks")
    .select("id, text, kind, track, reject_category, verified_at, run_id, prompt_version_id")
    .eq("status", "rejected")
    .gte("verified_at", since())
    .limit(100);

  return ((data ?? []) as unknown as {
    id: string;
    text: string | null;
    kind: string;
    track: string | null;
    reject_category: string | null;
    verified_at: string | null;
    run_id: string | null;
    prompt_version_id: string | null;
  }[]).map((h) => ({
    module: "personalization" as const,
    kind: "hook_reject" as const,
    scope: { track: h.track, hook_kind: h.kind },
    before_text: excerpt(h.text),
    after_text: null,
    category: h.reject_category,
    ref_table: "hooks",
    ref_id: h.id,
    run_id: h.run_id,
    prompt_version_id: h.prompt_version_id,
    occurred_at: h.verified_at ?? new Date().toISOString(),
  }));
}

/**
 * Graded corrections on sourced records: the field, what the model produced,
 * what the human replaced it with, and the error category.
 */
async function collectGradeCorrections(supabase: SupabaseClient): Promise<LearningSignal[]> {
  const { data } = await supabase
    .from("grades")
    .select("id, module, field, verdict, correction, previous_value, error_category, created_at, run_id")
    .in("verdict", ["wrong", "missing"])
    .gte("created_at", since())
    .limit(200);

  return ((data ?? []) as unknown as {
    id: string;
    module: string;
    field: string;
    correction: string | null;
    previous_value: string | null;
    error_category: string | null;
    created_at: string;
    run_id: string | null;
  }[]).map((g) => ({
    module: (g.module as LearningModule) ?? "sourcing",
    kind: "grade_correction" as const,
    scope: { field: g.field },
    before_text: excerpt(g.previous_value),
    after_text: excerpt(g.correction),
    category: g.error_category,
    ref_table: "grades",
    ref_id: g.id,
    run_id: g.run_id,
    prompt_version_id: null,
    occurred_at: g.created_at,
  }));
}

/**
 * Contacts deleted during review, with the operator's reason. A recurring
 * reason ("wrong company size", "not a decision maker") is a sourcing brief
 * that the prompt is currently missing.
 */
async function collectContactDeletes(supabase: SupabaseClient): Promise<LearningSignal[]> {
  const { data } = await supabase
    .from("contacts")
    .select("id, title, persona, delete_reason, deleted_at, run_id, organizations(name, kind)")
    .not("deleted_at", "is", null)
    .not("delete_reason", "is", null)
    .gte("deleted_at", since())
    .limit(150);

  return ((data ?? []) as unknown as {
    id: string;
    title: string | null;
    persona: string | null;
    delete_reason: string | null;
    deleted_at: string;
    run_id: string | null;
    organizations: { name: string; kind: string | null } | null;
  }[])
    // A blank reason is a click, not a lesson.
    .filter((c) => (c.delete_reason ?? "").trim().length > 2)
    .map((c) => ({
      module: "sourcing" as const,
      kind: "contact_delete" as const,
      scope: { persona: c.persona, org_kind: c.organizations?.kind ?? null },
      before_text: excerpt(
        [c.organizations?.name, c.title].filter(Boolean).join(" — ") || null,
      ),
      after_text: null,
      category: excerpt(c.delete_reason),
      ref_table: "contacts",
      ref_id: c.id,
      run_id: c.run_id,
      prompt_version_id: null,
      occurred_at: c.deleted_at,
    }));
}

/**
 * Harvest every source into learning_signals. Returns how many NEW signals
 * landed; conflicts on (ref_table, ref_id, kind) are ignored, which is what
 * makes this safe to run on every cron tick.
 */
export async function collectSignals(supabase: SupabaseClient): Promise<number> {
  const batches = await Promise.all([
    collectDraftEdits(supabase),
    collectRedrafts(supabase),
    collectHookRejects(supabase),
    collectGradeCorrections(supabase),
    collectContactDeletes(supabase),
  ]);
  const rows = batches.flat();
  if (!rows.length) return 0;

  const { data, error } = await supabase
    .from("learning_signals")
    .upsert(rows, { onConflict: "ref_table,ref_id,kind", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`Signal collection failed: ${error.message}`);
  return (data ?? []).length;
}

/** Unprocessed signals for a module, oldest first (a lesson ages out slowly). */
export async function unprocessedSignals(
  supabase: SupabaseClient,
  module: LearningModule,
  limit = 80,
): Promise<(LearningSignal & { id: string })[]> {
  const { data, error } = await supabase
    .from("learning_signals")
    .select("*")
    .eq("module", module)
    .is("processed_at", null)
    .order("occurred_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as (LearningSignal & { id: string })[];
}

export async function markProcessed(
  supabase: SupabaseClient,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await supabase
    .from("learning_signals")
    .update({ processed_at: new Date().toISOString() })
    .in("id", ids);
}
