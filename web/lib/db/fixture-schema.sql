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

create table public.profiles (
    id   uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'member'
);

create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create table public.organizations (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    domain          text unique,
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
    id          uuid primary key default gen_random_uuid(),
    module      text not null,
    label       text,
    gate_status text not null default 'open',
    created_at  timestamptz not null default now()
);

create table public.prompt_versions (
    id            uuid primary key default gen_random_uuid(),
    module        text not null,
    version       int not null,
    prompt        text not null,
    template_hash text,
    active        boolean not null default false,
    created_by    text,
    notes         text,
    created_at    timestamptz not null default now(),
    unique (module, version),
    unique (module, template_hash)
);

create table public.api_tokens (
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
    module          text primary key,
    gate_threshold  numeric,
    sample_rate     numeric not null default 1,
    min_sample_size int
);

create table public.rejected_ingest (
    id         uuid primary key default gen_random_uuid(),
    run_id     uuid references public.runs(id),
    payload    jsonb not null,
    reason     text,
    created_at timestamptz not null default now()
);

create table public.sourcing_runs (
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
      'create policy "members full access" on public.%I for all to authenticated '
      || 'using (public.user_role() in (''admin'',''member'')) '
      || 'with check (public.user_role() in (''admin'',''member''));', t);
  end loop;
end $$;

alter table public.api_tokens enable row level security;
create policy "api_tokens owner only" on public.api_tokens
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to authenticated;
grant all on all tables in schema public to authenticated;

insert into public.settings (module, sample_rate) values ('sourcing', 1);
