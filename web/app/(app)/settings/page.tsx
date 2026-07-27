import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SettingsPanel, type ModuleSettings, type PromptVersion } from "./settings-panel";
import { ApiTokens, type ApiTokenRow } from "./api-tokens";
import {
  PromptLearning,
  type LearningRunRow,
  type RuleRow,
  type StageHealthRow,
} from "./prompt-learning";
import { RunnerSetup } from "./runner-setup";
import { providerHint, resolveProvider } from "@/lib/learning/provider";
import { RUNNER_SKILL, RUNNER_REPO_URL, runnerEnvTemplate } from "@/lib/runner/skill";

// Settings: per-module eval-gate config (error threshold, sample rate), the
// prompt-version history (which version is active, add a new one), the runner
// API tokens, and the runner onboarding kit (skill file + .env) so a
// collaborator can be set up without repository access.

export default async function SettingsPage() {
  const supabase = await createClient();

  // Build the runner's .env from the host actually serving this page, so the
  // value handed to a collaborator is already right for prod, preview or local
  // rather than something they have to know to edit.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const envTemplate = runnerEnvTemplate(host ? `${proto}://${host}` : "https://your-app.vercel.app");

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

  // Prompt learning: the rules themselves, the analyzer's audit trail, and how
  // many corrections are queued but not yet read.
  const [{ data: rules }, { data: learningRuns }, { count: unprocessed }, { data: health }] =
    await Promise.all([
      supabase
        .from("prompt_rules")
        .select("*")
        .in("status", ["active", "proposed"])
        .order("created_at", { ascending: false }),
      supabase
        .from("learning_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("learning_signals")
        .select("id", { count: "exact", head: true })
        .is("processed_at", null),
      supabase.from("stage_health").select("*"),
    ]);

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
      <RunnerSetup
        skill={RUNNER_SKILL}
        repoUrl={RUNNER_REPO_URL}
        envTemplate={envTemplate}
        hasLiveToken={((tokens ?? []) as ApiTokenRow[]).some((t) => !t.revoked_at)}
      />
      <PromptLearning
        rules={(rules ?? []) as RuleRow[]}
        runs={(learningRuns ?? []) as LearningRunRow[]}
        health={(health ?? []) as StageHealthRow[]}
        unprocessed={unprocessed ?? 0}
        analyzerConfigured={Boolean(resolveProvider())}
        analyzerLabel={resolveProvider()?.label ?? providerHint()}
      />
      <ApiTokens tokens={(tokens ?? []) as ApiTokenRow[]} />
    </div>
  );
}
