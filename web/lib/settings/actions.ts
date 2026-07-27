"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { currentWorkspaceId } from "@/lib/workspace/context";

// Settings + prompt-version management. Admin/member only (RLS enforces; the
// allowlist layout gates the page). Prompt versions are immutable snapshots —
// you add a new version rather than editing, so error rates stay comparable
// across versions.
//
// Every statement here filters on workspace_id as well as module. RLS bounds
// these to workspaces the caller belongs to, but a member of two workspaces
// would otherwise flip the active prompt in BOTH from one click — module is
// unique per workspace, not globally.

export async function updateGateSettings(input: {
  module: string;
  gateThreshold: number;
  sampleRate: number;
  minSampleSize: number;
}): Promise<void> {
  await requireUser();
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();
  const { error } = await supabase
    .from("settings")
    .update({
      gate_threshold: input.gateThreshold,
      sample_rate: input.sampleRate,
      min_sample_size: input.minSampleSize,
    })
    .eq("workspace_id", workspaceId)
    .eq("module", input.module);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function activatePromptVersion(input: { id: string; module: string }): Promise<void> {
  await requireUser();
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();
  // One active version per module, per workspace.
  await supabase
    .from("prompt_versions")
    .update({ active: false })
    .eq("workspace_id", workspaceId)
    .eq("module", input.module);
  const { error } = await supabase
    .from("prompt_versions")
    .update({ active: true })
    .eq("workspace_id", workspaceId)
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function addPromptVersion(input: {
  module: string;
  prompt: string;
  notes?: string | null;
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();
  const workspaceId = await currentWorkspaceId();

  // Version numbers run per workspace — (workspace_id, module, version) is the
  // unique key — so the max must be read within this workspace or two tenants
  // would collide on the same next number.
  const { data: latest } = await supabase
    .from("prompt_versions")
    .select("version")
    .eq("workspace_id", workspaceId)
    .eq("module", input.module)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version ?? 0) + 1;

  await supabase
    .from("prompt_versions")
    .update({ active: false })
    .eq("workspace_id", workspaceId)
    .eq("module", input.module);
  const { error } = await supabase.from("prompt_versions").insert({
    workspace_id: workspaceId,
    module: input.module,
    version: nextVersion,
    prompt: input.prompt,
    notes: input.notes ?? null,
    active: true,
    created_by: user.email ?? user.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}
