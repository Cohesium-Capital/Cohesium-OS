-- 036_sending_identity.sql  (tenancy, phase 4 — who the mail comes from)
--
-- Sending is configured entirely by environment variables today: one SMTP
-- mailbox, one HeyReach account, one campaign. That is why the email cron has to
-- call soleWorkspaceId() and throw the moment a second workspace exists — it
-- cannot tell whose mail it is sending.
--
-- This makes the sending identity a row instead of an env var, per workspace and
-- optionally per user. Cohesium configures nothing and keeps working: the
-- resolver falls back to exactly today's environment variables when a workspace
-- has no identity row.
--
-- SECRETS ARE SPLIT INTO A SEPARATE TABLE ON PURPOSE.
--
-- An SMTP password is not workspace data. Every other table here is readable by
-- every member of the workspace, which is right for contacts and wrong for a
-- credential that can send mail as the firm. So the non-secret half is
-- member-readable and the secret half has NO policy for authenticated users at
-- all: with RLS enabled and no policy, PostgreSQL denies everything. The
-- service role — which the cron runs as — bypasses RLS and can read it; a
-- browser session, however privileged in the app, cannot. Writes go through a
-- SECURITY DEFINER function that checks admin and never returns the value back.

create table if not exists public.sending_identity (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces(id) on delete cascade,

    -- Null means the workspace's shared identity. A row WITH a user_id is that
    -- person's own — their mailbox, their LinkedIn account — which is what
    -- phase 4 is for: two people in one firm sending as themselves.
    user_id      uuid references auth.users(id) on delete cascade,

    channel      text not null check (channel in ('email','linkedin')),
    label        text,

    -- Email identity.
    from_name    text,
    from_email   text,
    smtp_host    text,
    smtp_port    int,
    smtp_user    text,
    imap_host    text,
    imap_port    int,
    imap_user    text,

    -- LinkedIn identity. The HeyReach API takes a linkedInAccountId per lead,
    -- so two members of one workspace can send from their own accounts in the
    -- same push — nothing about the provider forces a shared account.
    heyreach_account_id  text,
    heyreach_campaign_id text,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    updated_by   text
);

-- One identity per (workspace, user, channel). The partial index handles the
-- shared row, where user_id is null and a plain unique constraint would not
-- treat two nulls as equal.
create unique index if not exists sending_identity_user_key
  on public.sending_identity (workspace_id, user_id, channel) where user_id is not null;
create unique index if not exists sending_identity_shared_key
  on public.sending_identity (workspace_id, channel) where user_id is null;

alter table public.sending_identity enable row level security;

-- Members can see WHO the firm sends as; only admins can change it.
create policy "members read sending identities" on public.sending_identity
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "admins write sending identities" on public.sending_identity
  for insert to authenticated with check (public.is_workspace_admin(workspace_id));

create policy "admins update sending identities" on public.sending_identity
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "admins delete sending identities" on public.sending_identity
  for delete to authenticated using (public.is_workspace_admin(workspace_id));

-- ---------- secrets ----------

create table if not exists public.sending_secret (
    identity_id     uuid primary key references public.sending_identity(id) on delete cascade,
    smtp_pass       text,
    imap_pass       text,
    heyreach_api_key text,
    updated_at      timestamptz not null default now()
);

comment on table public.sending_secret is
  'Credentials for sending_identity. RLS on with NO authenticated policy: unreadable from any browser session. The cron reads it as service_role; admins write it via set_sending_secret().';

-- RLS on, deliberately without a single policy for `authenticated`. This is not
-- an omission — it is the mechanism. Adding any select policy here would put
-- SMTP passwords in reach of the browser.
alter table public.sending_secret enable row level security;

-- Writing a secret: admin-only, and the value never travels back out.
create or replace function public.set_sending_secret(
  p_identity_id uuid,
  p_smtp_pass text default null,
  p_imap_pass text default null,
  p_heyreach_api_key text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.sending_identity where id = p_identity_id;
  if ws is null then
    raise exception 'no such sending identity';
  end if;
  if not public.is_workspace_admin(ws) then
    raise exception 'only an admin of this workspace can set sending credentials';
  end if;

  insert into public.sending_secret (identity_id, smtp_pass, imap_pass, heyreach_api_key)
  values (p_identity_id, p_smtp_pass, p_imap_pass, p_heyreach_api_key)
  on conflict (identity_id) do update set
    -- A null argument means "leave this one alone", so the UI can save the
    -- SMTP password without having to re-send the HeyReach key it never showed
    -- the user in the first place.
    smtp_pass        = coalesce(excluded.smtp_pass,        sending_secret.smtp_pass),
    imap_pass        = coalesce(excluded.imap_pass,        sending_secret.imap_pass),
    heyreach_api_key = coalesce(excluded.heyreach_api_key, sending_secret.heyreach_api_key),
    updated_at       = now();
end;
$$;

revoke all on function public.set_sending_secret(uuid, text, text, text) from public;
grant execute on function public.set_sending_secret(uuid, text, text, text) to authenticated;

-- Which credentials EXIST, without revealing any of them. The Settings UI needs
-- to show "password set" versus "not set", and that question is safe to answer.
create or replace function public.sending_secret_status(p_identity_id uuid)
returns table (has_smtp_pass boolean, has_imap_pass boolean, has_heyreach_key boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.sending_identity where id = p_identity_id;
  if ws is null or not public.is_workspace_member(ws) then
    return;
  end if;
  return query
    select s.smtp_pass is not null, s.imap_pass is not null, s.heyreach_api_key is not null
      from public.sending_secret s where s.identity_id = p_identity_id;
end;
$$;

revoke all on function public.sending_secret_status(uuid) from public;
grant execute on function public.sending_secret_status(uuid) to authenticated;
