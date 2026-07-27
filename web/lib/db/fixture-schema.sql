-- Minimal but faithful subset of the production schema, for the runner-adapter
-- integration test. Mirrors the real column types (notably the jsonb columns and
-- uuid keys, which are exactly what the adapter has to bind correctly) and the
-- real RLS shape: auth.uid() driven by a GUC, policies gated on user_role().

create extension if not exists pgcrypto;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- Tenancy (mirrors migration 028). The fixture has to carry it or the RLS
-- tests would prove isolation for a schema production no longer runs.
create table public.workspaces (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_at timestamptz not null default now()
);

create table public.workspace_members (
    workspace_id uuid not null references public.workspaces(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null default 'member',
    is_default boolean not null default false,
    created_at timestamptz not null default now(),
    primary key (workspace_id, user_id)
);

create or replace function public.is_workspace_member(w uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = w and m.user_id = auth.uid())
$$;

create or replace function public.is_workspace_admin(w uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = w and m.user_id = auth.uid() and m.role = 'admin')
$$;

-- Administration is admin-only, and it is the DATABASE that has to say so.
-- Mirrors migrations 033 and 035. The 035 correction exists because a policy
-- NAMED for admins actually tested membership, and adding a stricter policy
-- alongside it changed nothing — permissive policies OR together.
alter table public.workspaces enable row level security;
create policy "members read their workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy "admins update their workspace" on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));

-- The prompt identity: readable by members, writable only by admins, because
-- its contents go verbatim into messages sent under the firm's name.
create table public.workspace_profile (
    workspace_id uuid primary key references public.workspaces(id) on delete cascade,
    firm_name text,
    sender_name text,
    sender_intro text,
    approach text,
    vocab jsonb,
    copy jsonb
);
alter table public.workspace_profile enable row level security;
create policy "members read the profile" on public.workspace_profile
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "admins write the profile" on public.workspace_profile
  for insert to authenticated with check (public.is_workspace_admin(workspace_id));
create policy "admins update the profile" on public.workspace_profile
  for update to authenticated
  using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));

create table public.profiles (
    id   uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'member'
);

create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create table public.organizations (
    workspace_id uuid not null references public.workspaces(id),
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    domain          text,
    kind            text,
    is_acq_target   boolean default false,
    current_msp_id  uuid references public.organizations(id),
    hq_city         text,
    hq_state        text,
    source_url      text,
    confidence      text,
    reviewed        boolean not null default false,
    evidence        jsonb not null default '[]',
    created_at      timestamptz not null default now()
);

create table public.batches (
    workspace_id uuid not null references public.workspaces(id),
    id          uuid primary key default gen_random_uuid(),
    module      text not null,
    label       text,
    gate_status text not null default 'open',
    created_at  timestamptz not null default now()
);

create table public.prompt_versions (
    workspace_id uuid not null references public.workspaces(id),
    id            uuid primary key default gen_random_uuid(),
    module        text not null,
    version       int not null,
    prompt        text not null,
    template_hash text,
    active        boolean not null default false,
    created_by    text,
    notes         text,
    created_at    timestamptz not null default now(),
    unique (workspace_id, module, version),
    unique (workspace_id, module, template_hash)
);

create table public.api_tokens (
    workspace_id uuid not null references public.workspaces(id),
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    token_hash text not null unique,
    prefix     text not null,
    owner_id   uuid not null references auth.users(id) on delete cascade,
    scopes     text[] not null default array['sourcing'],
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create table public.runs (
    workspace_id uuid not null references public.workspaces(id),
    id                uuid primary key default gen_random_uuid(),
    module            text not null,
    prompt_version_id uuid references public.prompt_versions(id),
    batch_id          uuid references public.batches(id),
    executor          text not null default 'copy_paste',
    provider_label    text,
    api_token_id      uuid references public.api_tokens(id) on delete set null,
    config            jsonb,
    status            text not null default 'awaiting_input',
    created_by        uuid,
    rendered_prompt   text,
    template_hash     text,
    started_at        timestamptz,
    finished_at       timestamptz,
    error             text,
    raw_io            jsonb,
    require_evidence  boolean,
    ingest_report     jsonb,
    created_at        timestamptz not null default now()
);

create table public.contacts (
    workspace_id uuid not null references public.workspaces(id),
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references public.organizations(id) on delete cascade,
    full_name         text,
    persona           text,
    title             text,
    linkedin_url      text,
    email             text,
    phone             text,
    source_url        text,
    confidence        text,
    source            text,
    stage             text,
    enrichment_status text not null default 'pending',
    reviewed          boolean not null default false,
    batch_id          uuid references public.batches(id),
    run_id            uuid references public.runs(id),
    evidence          jsonb not null default '[]',
    sampled           boolean not null default true,
    review_status     text not null default 'pending_review',
    clay_pushed_at    timestamptz,
    deleted_at        timestamptz,
    created_at        timestamptz not null default now()
);

create table public.settings (
    workspace_id uuid not null references public.workspaces(id),
    module          text not null,
    gate_threshold  numeric,
    sample_rate     numeric not null default 1,
    min_sample_size int,
    primary key (workspace_id, module)
);

create table public.rejected_ingest (
    workspace_id uuid not null references public.workspaces(id),
    id         uuid primary key default gen_random_uuid(),
    run_id     uuid references public.runs(id),
    payload    jsonb not null,
    reason     text,
    created_at timestamptz not null default now()
);

create table public.sourcing_runs (
    workspace_id uuid not null references public.workspaces(id),
    id                 uuid primary key default gen_random_uuid(),
    kind               text not null,
    target_msp_id      uuid,
    requested          int,
    inserted_orgs      int not null default 0,
    inserted_contacts  int not null default 0,
    skipped_duplicates int not null default 0,
    new_for_target     int,
    created_by         uuid,
    created_at         timestamptz not null default now(),
    run_id             uuid
);

create unique index organizations_workspace_domain_key
  on public.organizations (workspace_id, domain) where domain is not null;

-- RLS mirroring production: data tables are member-gated, api_tokens is
-- owner-only. The api_tokens policy is what proves the connection is genuinely
-- filtered rather than running as a bypassrls superuser.
do $$
declare t text;
begin
  foreach t in array array['organizations','contacts','batches','runs','prompt_versions',
                           'settings','rejected_ingest','sourcing_runs'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format(
      'create policy "workspace members" on public.%I for all to authenticated '
      || 'using (public.is_workspace_member(workspace_id)) '
      || 'with check (public.is_workspace_member(workspace_id));', t);
  end loop;
end $$;

alter table public.api_tokens enable row level security;
create policy "api_tokens owner only" on public.api_tokens
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated;
grant all on all tables in schema public to authenticated;

-- Two workspaces so the tests can prove one cannot see the other.
insert into public.workspaces (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'Workspace A'),
  ('b0000000-0000-0000-0000-00000000000b', 'Workspace B');

insert into public.settings (workspace_id, module, sample_rate)
values ('a0000000-0000-0000-0000-00000000000a', 'sourcing', 1);
