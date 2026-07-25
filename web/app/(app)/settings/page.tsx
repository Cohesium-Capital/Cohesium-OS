import { createClient } from "@/lib/supabase/server";
import { SettingsPanel, type ModuleSettings, type PromptVersion } from "./settings-panel";
import { ApiTokens, type ApiTokenRow } from "./api-tokens";

// Settings: per-module eval-gate config (error threshold, sample rate), the
// prompt-version history (which version is active, add a new one), and the
// runner API tokens.

export default async function SettingsPage() {
  const supabase = await createClient();

  const { data: settings } = await supabase
    .from("settings")
    .select("module, gate_threshold, sample_rate, min_sample_size")
    .order("module");

  const { data: prompts } = await supabase
    .from("prompt_versions")
    .select("id, module, version, prompt, notes, active, created_at, created_by")
    .order("module")
    .order("version", { ascending: false });

  // Owner-only by RLS, so this is already just the current user's tokens.
  const { data: tokens } = await supabase
    .from("api_tokens")
    .select("id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at")
    .order("created_at", { ascending: false });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Eval-gate thresholds, grading sample rates, and prompt versions per module.
        </p>
      </div>
      <SettingsPanel
        settings={(settings ?? []) as ModuleSettings[]}
        prompts={(prompts ?? []) as PromptVersion[]}
      />
      <ApiTokens tokens={(tokens ?? []) as ApiTokenRow[]} />
    </div>
  );
}
