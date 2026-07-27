-- 028_workspaces.sql  (tenancy, phase 1 of 4)
--
-- Makes the app multi-tenant. A workspace is the operator's firm; a user belongs
-- to one or more and switches between them. Cohesium becomes the first
-- workspace and owns every existing row, so behaviour is unchanged after this
-- migration — the point of phase 1 is that nothing looks different while the
-- foundation moves underneath.
--
-- TWO DECISIONS ARE ENCODED HERE, both worth understanding before extending it.
--
-- 1. RLS enforces MEMBERSHIP, not the currently-selected workspace.
--    A policy of "workspace_id = the workspace you're looking at" would mean
--    minting a new JWT on every switch, because browser sessions reach Postgres
--    through PostgREST where a per-request GUC isn't available. Instead the
--    policy asks "are you a member of the workspace that owns this row", and the
--    application filters to the selected one. Isolation is structural — you can
--    never read a workspace you don't belong to, whatever the app does — while
--    switching stays a cookie. withRls needs no change.
--
-- 2. Child tables have no workspace_id; they inherit through their parent.
--    A grade belongs to the workspace of its contact, by definition. Copying the
--    id onto every child would create a second source of truth that can drift
--    out of agreement with the first. The policies below traverse the FK instead.

-- ---------- 1. the tenant ----------

create table if not exists public.workspaces (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
    workspace_id uuid not null references public.workspaces(id) on delete cascade,
    user_id      uuid not null references auth.users(id) on delete cascade,
    -- The user's role WITHIN this workspace: someone can run one firm and
    -- collaborate on another.
    role         text not null default 'member' check (role in ('admin','member','partner')),
    is_default   boolean not null default false,
    created_at   timestamptz not null default now(),
    primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

-- Membership test used by every policy below.
--
-- SECURITY DEFINER on purpose: workspace_members carries RLS of its own, and a
-- policy that queried it directly would recurse. Definer rights break the cycle.
-- It is safe because it answers exactly one question about the CALLER — it takes
-- no user input beyond a workspace id and leaks nothing about other users.
create or replace function public.is_workspace_member(w uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
     where m.workspace_id = w and m.user_id = auth.uid()
  )
$$;

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

alter table public.workspaces enable row level security;
drop policy if exists "members read their workspaces" on public.workspaces;
create policy "members read their workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));

drop policy if exists "admins update their workspaces" on public.workspaces;
create policy "admins update their workspaces" on public.workspaces
  for update to authenticated using (public.is_workspace_member(id))
  with check (public.is_workspace_member(id));

alter table public.workspace_members enable row level security;
drop policy if exists "members read their own memberships" on public.workspace_members;
create policy "members read their own memberships" on public.workspace_members
  for select to authenticated
  -- Your own rows, plus everyone in a workspace you belong to (the member list).
  using (user_id = auth.uid() or public.is_workspace_member(workspace_id));

-- ---------- 2. seed Cohesium and make today's users members ----------

insert into public.workspaces (name)
select 'Cohesium'
 where not exists (select 1 from public.workspaces);

insert into public.workspace_members (workspace_id, user_id, role, is_default)
select w.id, p.id, coalesce(p.role, 'member'), true
  from public.profiles p
 cross join (select id from public.workspaces order by created_at limit 1) w
 on conflict (workspace_id, user_id) do nothing;


-- ---------- 3. workspace_id on root tables ----------
--
-- interactions and rejected_ingest are here rather than in the child set for a
-- specific reason: their parent FK is NULLABLE. An inbound reply that hasn't
-- been matched to a contact yet has contact_id null (there is one such row in
-- production today), and a policy that traverses that FK would make it visible
-- to NOBODY — it would simply vanish from Triage with no error. A row that
-- cannot name its parent has to carry its own workspace.

alter table public.organizations add column if not exists workspace_id uuid references public.workspaces(id);
update public.organizations set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.organizations alter column workspace_id set not null;
create index if not exists organizations_workspace_idx on public.organizations (workspace_id);

alter table public.contacts add column if not exists workspace_id uuid references public.workspaces(id);
update public.contacts set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.contacts alter column workspace_id set not null;
create index if not exists contacts_workspace_idx on public.contacts (workspace_id);

alter table public.batches add column if not exists workspace_id uuid references public.workspaces(id);
update public.batches set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.batches alter column workspace_id set not null;
create index if not exists batches_workspace_idx on public.batches (workspace_id);

alter table public.runs add column if not exists workspace_id uuid references public.workspaces(id);
update public.runs set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.runs alter column workspace_id set not null;
create index if not exists runs_workspace_idx on public.runs (workspace_id);

alter table public.touches add column if not exists workspace_id uuid references public.workspaces(id);
update public.touches set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.touches alter column workspace_id set not null;
create index if not exists touches_workspace_idx on public.touches (workspace_id);

alter table public.hooks add column if not exists workspace_id uuid references public.workspaces(id);
update public.hooks set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.hooks alter column workspace_id set not null;
create index if not exists hooks_workspace_idx on public.hooks (workspace_id);

alter table public.sourcing_runs add column if not exists workspace_id uuid references public.workspaces(id);
update public.sourcing_runs set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.sourcing_runs alter column workspace_id set not null;
create index if not exists sourcing_runs_workspace_idx on public.sourcing_runs (workspace_id);

alter table public.prompt_versions add column if not exists workspace_id uuid references public.workspaces(id);
update public.prompt_versions set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.prompt_versions alter column workspace_id set not null;
create index if not exists prompt_versions_workspace_idx on public.prompt_versions (workspace_id);

alter table public.prompt_rules add column if not exists workspace_id uuid references public.workspaces(id);
update public.prompt_rules set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.prompt_rules alter column workspace_id set not null;
create index if not exists prompt_rules_workspace_idx on public.prompt_rules (workspace_id);

alter table public.learning_signals add column if not exists workspace_id uuid references public.workspaces(id);
update public.learning_signals set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.learning_signals alter column workspace_id set not null;
create index if not exists learning_signals_workspace_idx on public.learning_signals (workspace_id);

alter table public.learning_runs add column if not exists workspace_id uuid references public.workspaces(id);
update public.learning_runs set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.learning_runs alter column workspace_id set not null;
create index if not exists learning_runs_workspace_idx on public.learning_runs (workspace_id);

alter table public.settings add column if not exists workspace_id uuid references public.workspaces(id);
update public.settings set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.settings alter column workspace_id set not null;
create index if not exists settings_workspace_idx on public.settings (workspace_id);

alter table public.settings_history add column if not exists workspace_id uuid references public.workspaces(id);
update public.settings_history set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.settings_history alter column workspace_id set not null;
create index if not exists settings_history_workspace_idx on public.settings_history (workspace_id);


alter table public.interactions add column if not exists workspace_id uuid references public.workspaces(id);
update public.interactions set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.interactions alter column workspace_id set not null;
create index if not exists interactions_workspace_idx on public.interactions (workspace_id);

alter table public.rejected_ingest add column if not exists workspace_id uuid references public.workspaces(id);
update public.rejected_ingest set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
alter table public.rejected_ingest alter column workspace_id set not null;
create index if not exists rejected_ingest_workspace_idx on public.rejected_ingest (workspace_id);

-- api_tokens needs one too, for a different reason: a runner token writes rows,
-- and owner alone no longer says where they land once a user has more than one
-- workspace. The token acts in exactly one.
alter table public.api_tokens add column if not exists workspace_id uuid references public.workspaces(id);
update public.api_tokens set workspace_id = (select id from public.workspaces order by created_at limit 1) where workspace_id is null;
create index if not exists api_tokens_workspace_idx on public.api_tokens (workspace_id);

-- ---------- 4. constraints that were globally unique ----------
-- These break tenancy before RLS gets a chance to: two workspaces prospecting
-- the same company, or configuring the same module, would collide on insert.

alter table public.organizations drop constraint if exists organizations_domain_key;
create unique index if not exists organizations_workspace_domain_key
  on public.organizations (workspace_id, domain) where domain is not null;

alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings add primary key (workspace_id, module);

alter table public.prompt_versions drop constraint if exists prompt_versions_module_version_key;
create unique index if not exists prompt_versions_ws_module_version_key
  on public.prompt_versions (workspace_id, module, version);
drop index if exists prompt_versions_module_hash_key;
create unique index if not exists prompt_versions_ws_module_hash_key
  on public.prompt_versions (workspace_id, module, template_hash) where template_hash is not null;


-- ---------- 5. policies: root tables scope on their own column ----------

drop policy if exists "members full access" on public.organizations;
create policy "workspace members" on public.organizations
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.contacts;
create policy "workspace members" on public.contacts
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.batches;
create policy "workspace members" on public.batches
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.runs;
create policy "workspace members" on public.runs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.touches;
create policy "workspace members" on public.touches
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.hooks;
create policy "workspace members" on public.hooks
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.sourcing_runs;
create policy "workspace members" on public.sourcing_runs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.prompt_versions;
create policy "workspace members" on public.prompt_versions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.prompt_rules;
create policy "workspace members" on public.prompt_rules
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.learning_signals;
create policy "workspace members" on public.learning_signals
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.learning_runs;
create policy "workspace members" on public.learning_runs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.settings;
create policy "workspace members" on public.settings
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.settings_history;
create policy "workspace members" on public.settings_history
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));


drop policy if exists "members full access" on public.interactions;
create policy "workspace members" on public.interactions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "members full access" on public.rejected_ingest;
create policy "workspace members" on public.rejected_ingest
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ---------- 6. policies: child tables scope through their parent ----------

drop policy if exists "members full access" on public.enrichment_events;
create policy "workspace members via contacts" on public.enrichment_events
  for all to authenticated
  using (exists (select 1 from public.contacts p
                  where p.id = enrichment_events.contact_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.contacts p
                  where p.id = enrichment_events.contact_id and public.is_workspace_member(p.workspace_id)));

drop policy if exists "members full access" on public.grades;
create policy "workspace members via contacts" on public.grades
  for all to authenticated
  using (exists (select 1 from public.contacts p
                  where p.id = grades.contact_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.contacts p
                  where p.id = grades.contact_id and public.is_workspace_member(p.workspace_id)));

drop policy if exists "members full access" on public.suppressions;
create policy "workspace members via contacts" on public.suppressions
  for all to authenticated
  using (exists (select 1 from public.contacts p
                  where p.id = suppressions.contact_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.contacts p
                  where p.id = suppressions.contact_id and public.is_workspace_member(p.workspace_id)));


drop policy if exists "members full access" on public.intro_paths;
create policy "workspace members via contacts" on public.intro_paths
  for all to authenticated
  using (exists (select 1 from public.contacts p
                  where p.id = intro_paths.from_contact_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.contacts p
                  where p.id = intro_paths.from_contact_id and public.is_workspace_member(p.workspace_id)));

drop policy if exists "members full access" on public.touch_edits;
create policy "workspace members via touches" on public.touch_edits
  for all to authenticated
  using (exists (select 1 from public.touches p
                  where p.id = touch_edits.touch_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.touches p
                  where p.id = touch_edits.touch_id and public.is_workspace_member(p.workspace_id)));

drop policy if exists "members full access" on public.gate_decisions;
create policy "workspace members via batches" on public.gate_decisions
  for all to authenticated
  using (exists (select 1 from public.batches p
                  where p.id = gate_decisions.batch_id and public.is_workspace_member(p.workspace_id)))
  with check (exists (select 1 from public.batches p
                  where p.id = gate_decisions.batch_id and public.is_workspace_member(p.workspace_id)));



-- extractions hangs off interactions, which now owns a workspace_id, so this is
-- a single hop rather than a join through contacts.
drop policy if exists "members full access" on public.extractions;
create policy "workspace members via interactions" on public.extractions
  for all to authenticated
  using (exists (select 1 from public.interactions i
                  where i.id = extractions.interaction_id
                    and public.is_workspace_member(i.workspace_id)))
  with check (exists (select 1 from public.interactions i
                  where i.id = extractions.interaction_id
                    and public.is_workspace_member(i.workspace_id)));
