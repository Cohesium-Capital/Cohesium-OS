-- 022_runner_tokens.sql
-- Scoped API tokens for the runner executor (a Claude Code session driving a
-- sourcing run from outside the browser).
--
-- Why a token table rather than the service-role key: the service key bypasses
-- RLS entirely. Handing it to a local agent session means that session can read
-- every row in the database — today that is "all of your data", and the moment
-- tenancy lands it becomes "every tenant's data". A token here resolves to ONE
-- owning user, and the API mints a short-lived user JWT from it, so every
-- runner request executes under that user's identity with RLS applied exactly
-- as it is for a browser session. Nothing about the runner path is privileged.
--
-- Only the SHA-256 hash is stored. The raw token is shown once at creation and
-- is unrecoverable afterwards, so a database leak does not yield usable tokens.

create table if not exists public.api_tokens (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    -- sha256 hex of the raw token; the raw value is never persisted.
    token_hash  text not null unique,
    -- Leading public segment of the raw token ("cin_live_a1b2c3d4"), for
    -- identifying a token in the UI and in logs without revealing it.
    prefix      text not null,
    owner_id    uuid not null references auth.users(id) on delete cascade,
    -- Capability scopes. 'sourcing' = may create/ingest sourcing runs and check
    -- candidates. Kept as an array so a token can be narrowed further later.
    scopes      text[] not null default array['sourcing'],
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz
);

create index if not exists api_tokens_owner_idx on public.api_tokens (owner_id);
-- Auth looks a token up by hash on every request; it must be an index hit.
create unique index if not exists api_tokens_hash_idx on public.api_tokens (token_hash);

alter table public.api_tokens enable row level security;

-- A token is a credential for its owner: only the owner may see or manage it.
-- Deliberately NOT the "members full access" pattern the data tables use —
-- one member must not be able to mint or read a credential that acts as
-- another. Admins are excluded for the same reason; an admin who needs runner
-- access creates their own token.
drop policy if exists "api_tokens owner only" on public.api_tokens;
create policy "api_tokens owner only" on public.api_tokens
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

comment on table public.api_tokens is
  'Scoped API tokens for non-browser callers (the runner executor). Resolves to one owning user; the API mints a short-lived user JWT so RLS applies. Only the hash is stored.';

-- Runner runs are already representable: runs.executor allows 'runner'
-- alongside 'copy_paste' (migration 010). Record which token drove a run so a
-- compromised or misbehaving token's output can be traced and rolled back.
alter table public.runs
  add column if not exists api_token_id uuid references public.api_tokens(id) on delete set null;

create index if not exists runs_api_token_idx on public.runs (api_token_id)
  where api_token_id is not null;
