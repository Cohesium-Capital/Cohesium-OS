import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { currentWorkspace, currentWorkspaceId } from "@/lib/workspace/context";
import { WorkspacePanel, type MemberRow, type InviteRow } from "./workspace-panel";
import { workspaceRoster, sendingIdentities } from "@/lib/workspace/admin-actions";
import { SendingPanel } from "./sending-panel";
import { WorkedExamplesPanel } from "./worked-examples-panel";
import { currentWorkedExamples } from "@/lib/workspace/admin-actions";
import { SenderPanel } from "./sender-panel";
import { myMemberSender } from "@/lib/settings/actions";
import { senderOverridesFor } from "@/lib/workspace/sender";
import { AccessRequestsPanel } from "./access-requests-panel";
import { pendingAccessRequests, isInstanceOperator } from "@/lib/access/actions";
import { envEmailIdentity, emailIdentityReady } from "@/lib/send/identity-env";
import { operatorWorkspaceId } from "@/lib/workspace/resolve";
import { createAdminClient } from "@/lib/supabase/admin";
import { workspaceProfile } from "@/lib/workspace/profile";
import { DEFAULT_PROFILE } from "@/lib/workspace/identity";
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
import { renderRunnerSkill, RUNNER_REPO_URL, runnerEnvTemplate } from "@/lib/runner/skill";

// Settings: per-module eval-gate config (error threshold, sample rate), the
// prompt-version history (which version is active, add a new one), the runner
// API tokens, and the runner onboarding kit (skill file + .env) so a
// collaborator can be set up without repository access.

export default async function SettingsPage() {
  const supabase = await createClient();
  const user = await requireUser();
  // Settings, prompts and learned rules are all per workspace: this page shows
  // the one on screen, not the union of every workspace the user belongs to.
  const workspaceId = await currentWorkspaceId();

  // (Invites are claimed in the app layout, before the membership gate — a
  // workspace-less invitee never reaches this page.)
  const workspace = await currentWorkspace();
  const [roster, profile, identities, operator, examples] = await Promise.all([
    workspaceRoster(),
    workspaceProfile(supabase, workspaceId),
    sendingIdentities(),
    isInstanceOperator(),
    currentWorkedExamples(),
  ]);
  // Only whoever runs this deployment sees other firms' requests to join it.
  const accessRequests = operator ? await pendingAccessRequests() : [];

  // The current user's own sign-off, and what they'd sign as if they leave it
  // blank: their auto-resolved name (sending identity / profile) over the
  // workspace default. The placeholder tells that truth (migration 045).
  const [mine, auto] = await Promise.all([
    myMemberSender(),
    senderOverridesFor(supabase, workspaceId, user.id),
  ]);
  const resolvedSenderName = auto.senderName ?? profile.senderName;
  const resolvedSenderIntro = auto.senderIntro ?? profile.senderIntro;
  const resolvedApproach = auto.approach ?? profile.approach;
  // Show only what this workspace has actually overridden: a field equal to the
  // default renders blank, so the placeholder tells the truth about where the
  // value comes from.
  const overrideOf = (value: string, fallback: string) => (value === fallback ? "" : value);
  const vocabOverrides = Object.fromEntries(
    Object.entries(profile.vocab).map(([k, v]) => [
      k,
      overrideOf(v, DEFAULT_PROFILE.vocab[k as keyof typeof DEFAULT_PROFILE.vocab]),
    ]),
  );
  const hasOverrides =
    JSON.stringify({ ...profile, copy: null }) !==
    JSON.stringify({ ...DEFAULT_PROFILE, copy: null });

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
    .eq("workspace_id", workspaceId)
    .order("module");

  const { data: prompts } = await supabase
    .from("prompt_versions")
    .select("id, module, version, prompt, notes, active, created_at, created_by")
    .eq("workspace_id", workspaceId)
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
        .eq("workspace_id", workspaceId)
        .in("status", ["active", "proposed"])
        .order("created_at", { ascending: false }),
      supabase
        .from("learning_runs")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("learning_signals")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .is("processed_at", null),
      supabase.from("stage_health").select("*").eq("workspace_id", workspaceId),
    ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Eval-gate thresholds, grading sample rates, and prompt versions per module.
        </p>
      </div>
      <AccessRequestsPanel requests={accessRequests} />
      <WorkspacePanel
        key={`ws-${workspaceId}`}
        workspaceName={workspace?.name ?? "Workspace"}
        isAdmin={workspace?.role === "admin"}
        members={roster.members as MemberRow[]}
        invites={roster.invites as InviteRow[]}
        profile={{
          firmName: overrideOf(profile.firmName, DEFAULT_PROFILE.firmName),
          senderIntro: overrideOf(profile.senderIntro, DEFAULT_PROFILE.senderIntro),
          approach: overrideOf(profile.approach, DEFAULT_PROFILE.approach),
          vocab: vocabOverrides,
        }}
        defaults={{
          firmName: DEFAULT_PROFILE.firmName,
          senderIntro: DEFAULT_PROFILE.senderIntro,
          approach: DEFAULT_PROFILE.approach,
          vocab: { ...DEFAULT_PROFILE.vocab },
        }}
        hasOverrides={hasOverrides}
      />
      <SenderPanel
        key={`sender-${workspaceId}`}
        initialName={mine?.senderName ?? ""}
        initialIntro={mine?.senderIntro ?? ""}
        initialApproach={mine?.approach ?? ""}
        placeholderName={resolvedSenderName}
        placeholderIntro={resolvedSenderIntro}
        placeholderApproach={resolvedApproach}
      />
      <WorkedExamplesPanel
        key={`ex-${workspaceId}`}
        goldCustomer={examples.goldCustomer}
        goldMsp={examples.goldMsp}
        isDefault={examples.isDefault}
        isAdmin={workspace?.role === "admin"}
      />
      <SendingPanel
        key={`send-${workspaceId}`}
        identities={identities}
        members={roster.members.map((m) => ({ userId: m.userId, email: m.email }))}
        isAdmin={workspace?.role === "admin"}
        currentUserId={user.id}
        // The env mailbox belongs to the operator workspace alone; any other
        // workspace with no identities has NOTHING configured, and the panel
        // must say so rather than imply the env will cover it. Resolved with
        // the admin client: a user client would report the caller's own oldest
        // workspace, not the instance's.
        envConfigured={
          workspaceId === (await operatorWorkspaceId(createAdminClient())) &&
          !emailIdentityReady(envEmailIdentity())
        }
      />
      <SettingsPanel
        key={`gate-${workspaceId}`}
        settings={(settings ?? []) as ModuleSettings[]}
        prompts={(prompts ?? []) as PromptVersion[]}
      />
      <RunnerSetup
        skill={renderRunnerSkill(profile.vocab)}
        repoUrl={RUNNER_REPO_URL}
        envTemplate={envTemplate}
        hasLiveToken={((tokens ?? []) as ApiTokenRow[]).some((t) => !t.revoked_at)}
      />
      <PromptLearning
        key={`learn-${workspaceId}`}
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
