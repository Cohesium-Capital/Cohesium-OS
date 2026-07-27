-- 043_personal_identities_follow_user.sql
--
-- Two ownership fixes.
--
-- 1. A PERSONAL sending identity belongs to the person, not to one workspace.
--    036 keyed every identity on workspace_id, so someone in two workspaces
--    had to configure their own mailbox twice and the copies could drift.
--    Personal rows (user_id set) now carry NO workspace: one row per person
--    per channel, following them across every workspace they belong to.
--    Workspace-SHARED rows (user_id null) still belong to their workspace —
--    a firm mailbox is the firm's.
--
--    Ownership moves with scoping: a personal identity is managed by ITS
--    OWNER (any member, for their own), not by workspace admins — it is their
--    mailbox and their credentials. Shared identities stay admin-managed.
--
-- 2. The Settings roster showed raw user ids for everyone but the viewer:
--    profiles' read policy predates tenancy (`id = auth.uid() or the legacy
--    global admin role`, which nobody holds), so co-members' emails were
--    unreadable. You can now read the profile of anyone you share a
--    workspace with — which is exactly the set the roster shows.

-- ---------- 1a. who shares a workspace with whom ----------
-- SECURITY DEFINER for the same reason as is_workspace_member: it reads
-- workspace_members, whose own RLS would recurse. It answers one yes/no
-- question about the caller and one other user, and leaks nothing else.
create or replace function public.shares_workspace_with(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.workspace_members a
      join public.workspace_members b on b.workspace_id = a.workspace_id
     where a.user_id = auth.uid() and b.user_id = other
  )
$$;

revoke all on function public.shares_workspace_with(uuid) from public;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

-- ---------- 1b. profiles readable across shared workspaces ----------
drop policy if exists "profiles self or admin read" on public.profiles;
create policy "profiles self or admin read" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.shares_workspace_with(id)
    -- the legacy global-admin escape hatch, kept for compatibility
    or public.user_role() = 'admin'
  );

-- ---------- 2a. personal identities lose their workspace pin ----------

alter table public.sending_identity alter column workspace_id drop not null;

-- Defensive for environments with existing personal rows (production has
-- none): keep the most recently updated row per (user, channel), then strip
-- the workspace pin from the survivors.
delete from public.sending_identity s
 using public.sending_identity newer
 where s.user_id is not null
   and newer.user_id = s.user_id
   and newer.channel = s.channel
   and newer.id <> s.id
   and (newer.updated_at > s.updated_at
        or (newer.updated_at = s.updated_at and newer.id > s.id));

update public.sending_identity set workspace_id = null where user_id is not null;

-- Exactly one owner: a personal row has a user and no workspace; a shared row
-- has a workspace and no user.
alter table public.sending_identity drop constraint if exists sending_identity_one_owner;
alter table public.sending_identity add constraint sending_identity_one_owner
  check ((user_id is null) <> (workspace_id is null));

drop index if exists sending_identity_user_key;
create unique index sending_identity_user_key
  on public.sending_identity (user_id, channel) where user_id is not null;
-- sending_identity_shared_key (workspace_id, channel) where user_id is null
-- remains correct as created by 036.

-- ---------- 2b. policies: owner manages personal, admins manage shared ----------

drop policy if exists "members read sending identities" on public.sending_identity;
create policy "members read sending identities" on public.sending_identity
  for select to authenticated using (
    case when user_id is null
      then public.is_workspace_member(workspace_id)          -- shared: members
      else user_id = auth.uid()                              -- personal: owner…
           or public.shares_workspace_with(user_id)          -- …and their co-members
    end
  );

drop policy if exists "admins write sending identities" on public.sending_identity;
create policy "admins write sending identities" on public.sending_identity
  for insert to authenticated with check (
    case when user_id is null
      then public.is_workspace_admin(workspace_id)
      else user_id = auth.uid()
    end
  );

drop policy if exists "admins update sending identities" on public.sending_identity;
create policy "admins update sending identities" on public.sending_identity
  for update to authenticated
  using (
    case when user_id is null
      then public.is_workspace_admin(workspace_id)
      else user_id = auth.uid()
    end
  )
  with check (
    case when user_id is null
      then public.is_workspace_admin(workspace_id)
      else user_id = auth.uid()
    end
  );

drop policy if exists "admins delete sending identities" on public.sending_identity;
create policy "admins delete sending identities" on public.sending_identity
  for delete to authenticated using (
    case when user_id is null
      then public.is_workspace_admin(workspace_id)
      else user_id = auth.uid()
    end
  );

-- ---------- 2c. secret functions follow the same ownership ----------

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
  ws  uuid;
  own uuid;
begin
  select workspace_id, user_id into ws, own
    from public.sending_identity where id = p_identity_id;
  if not found then
    raise exception 'no such sending identity';
  end if;
  if own is not null then
    if own <> auth.uid() then
      raise exception 'only the owner of a personal sending identity can set its credentials';
    end if;
  elsif not public.is_workspace_admin(ws) then
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

create or replace function public.sending_secret_status(p_identity_id uuid)
returns table (has_smtp_pass boolean, has_imap_pass boolean, has_heyreach_key boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  ws  uuid;
  own uuid;
begin
  select workspace_id, user_id into ws, own
    from public.sending_identity where id = p_identity_id;
  if not found then
    return;
  end if;
  if own is not null then
    if own <> auth.uid() and not public.shares_workspace_with(own) then
      return;
    end if;
  elsif not public.is_workspace_member(ws) then
    return;
  end if;
  return query
    select s.smtp_pass is not null, s.imap_pass is not null, s.heyreach_api_key is not null
      from public.sending_secret s where s.identity_id = p_identity_id;
end;
$$;
