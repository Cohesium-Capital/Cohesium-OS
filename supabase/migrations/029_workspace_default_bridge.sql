-- 029_workspace_default_bridge.sql  (tenancy, phase 1 — temporary bridge)
--
-- 028 made workspace_id NOT NULL on sixteen tables. Every INSERT in the app
-- predates the column and omits it, so as of 028 the next import, run, draft or
-- reply capture would fail outright. This keeps production working until the
-- application passes a workspace explicitly (phase 1b).
--
-- The default resolves in this order:
--   1. the caller's default workspace membership, when there is an auth.uid()
--      (a browser session or a runner request through withRls)
--   2. otherwise the single oldest workspace — which is Cohesium, and is
--      correct precisely as long as one workspace exists
--
-- ⚠️ THIS IS A BRIDGE, NOT A DESIGN. While these defaults exist, code that
-- forgets to set workspace_id writes somewhere plausible instead of failing
-- loudly, and once a second workspace exists that silence becomes a
-- cross-tenant write. Phase 1b passes workspace_id explicitly from the request
-- context and migration 030 drops every default below. Do not create a second
-- workspace until it has.

create or replace function public.default_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.workspace_id from public.workspace_members m
      where m.user_id = auth.uid()
      order by m.is_default desc, m.created_at
      limit 1),
    (select id from public.workspaces order by created_at limit 1)
  )
$$;

revoke all on function public.default_workspace_id() from public;
grant execute on function public.default_workspace_id() to authenticated, service_role;

alter table public.organizations alter column workspace_id set default public.default_workspace_id();
alter table public.contacts alter column workspace_id set default public.default_workspace_id();
alter table public.batches alter column workspace_id set default public.default_workspace_id();
alter table public.runs alter column workspace_id set default public.default_workspace_id();
alter table public.touches alter column workspace_id set default public.default_workspace_id();
alter table public.hooks alter column workspace_id set default public.default_workspace_id();
alter table public.sourcing_runs alter column workspace_id set default public.default_workspace_id();
alter table public.prompt_versions alter column workspace_id set default public.default_workspace_id();
alter table public.prompt_rules alter column workspace_id set default public.default_workspace_id();
alter table public.learning_signals alter column workspace_id set default public.default_workspace_id();
alter table public.learning_runs alter column workspace_id set default public.default_workspace_id();
alter table public.settings alter column workspace_id set default public.default_workspace_id();
alter table public.settings_history alter column workspace_id set default public.default_workspace_id();
alter table public.interactions alter column workspace_id set default public.default_workspace_id();
alter table public.rejected_ingest alter column workspace_id set default public.default_workspace_id();
alter table public.api_tokens alter column workspace_id set default public.default_workspace_id();
