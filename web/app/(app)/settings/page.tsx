import { createClient } from "@/lib/supabase/server";
import { SettingsPanel, type ModuleSettings, type PromptVersion } from "./settings-panel";

// Settings: per-module eval-gate config (error threshold, sample rate) and the
// prompt-version history (which version is active, add a new one).

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
    </div>
  );
}
