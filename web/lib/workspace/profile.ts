import type { SupabaseClient } from "@supabase/supabase-js";
import {
  completeProfile,
  DEFAULT_PROFILE,
  type WorkspaceProfile,
  type WorkspaceVocab,
  type DraftCopy,
} from "./identity";

// Loading a workspace's prompt identity.
//
// The table stores overrides only (migration 032), so this reads a row that is
// usually absent and fills everything from the defaults. That is the whole
// mechanism: Cohesium has no row, so Cohesium's prompts are the defaults, which
// are the strings that used to be inline in the builders.

type ProfileRow = {
  firm_name: string | null;
  sender_name: string | null;
  sender_intro: string | null;
  approach: string | null;
  vocab: Partial<WorkspaceVocab> | null;
  copy: Partial<DraftCopy> | null;
};

/**
 * The workspace's prompt profile, defaults filled in.
 *
 * Never throws. A prompt must be buildable even when this table is unreachable
 * — not yet migrated, RLS surprise, outage — because the alternative is that
 * the operator cannot run the pipeline at all. Falling back to the defaults is
 * always a valid state, and for Cohesium it is the correct one.
 */
export async function workspaceProfile(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceProfile> {
  try {
    const { data } = await supabase
      .from("workspace_profile")
      .select("firm_name, sender_name, sender_intro, approach, vocab, copy")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!data) return DEFAULT_PROFILE;

    const row = data as ProfileRow;
    // Explicit key-by-key rather than a spread: a null column means "default",
    // and spreading would overwrite the default WITH the null.
    return completeProfile({
      ...(row.firm_name ? { firmName: row.firm_name } : {}),
      ...(row.sender_name ? { senderName: row.sender_name } : {}),
      ...(row.sender_intro ? { senderIntro: row.sender_intro } : {}),
      ...(row.approach ? { approach: row.approach } : {}),
      ...(row.vocab ? { vocab: row.vocab as WorkspaceVocab } : {}),
      ...(row.copy ? { copy: row.copy as DraftCopy } : {}),
    });
  } catch {
    return DEFAULT_PROFILE;
  }
}
