-- 033_workspace_admin.sql  (tenancy, phase 3 — administration)
--
-- 028 gave workspaces and workspace_members SELECT policies only. That was
-- correct then: one workspace existed and it was seeded by the migration
-- itself. To let a firm create a workspace, invite a colleague and hand over
-- admin, those tables need write policies — and they are the two tables where a
-- careless policy is worst, because a row here grants access to every other
-- table in the database.
--
-- The rule throughout: administering a workspace requires being an ADMIN OF
-- THAT WORKSPACE. Not a member; not an admin of some other workspace; not the
-- legacy global profiles.role, which predates tenancy and says nothing about
-- which firm a user belongs to.

-- ---------- 1. the admin test ----------

-- SECURITY DEFINER for the same reason as is_workspace_member: a policy on
-- workspace_members that queried workspace_members would recurse. It answers one
-- question about the CALLER and takes no user input beyond a workspace id.
create or replace function public.is_workspace_admin(w uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
     where m.workspace_id = w
       and m.user_id = auth.uid()
       and m.role = 'admin'
  )
$$;

revoke all on function public.is_workspace_admin(uuid) from public;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;

-- ---------- 2. creating a workspace ----------

-- Creation is a function rather than an INSERT policy because it is inherently
-- two statements that must not be separable: the workspace, and the creator's
-- admin membership. An INSERT policy on `workspaces` would leave a window — and
-- a failure mode — where a workspace exists that nobody can administer or even
-- see, because membership is what grants visibility.
create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  clean  text := nullif(btrim(workspace_name), '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if clean is null then
    raise exception 'a workspace needs a name';
  end if;

  insert into public.workspaces (name) values (clean) returning id into new_id;

  -- The creator is an admin, and this is their default only if they have no
  -- other default — switching workspaces should not silently move someone's
  -- landing place.
  insert into public.workspace_members (workspace_id, user_id, role, is_default)
  values (
    new_id,
    auth.uid(),
    'admin',
    not exists (select 1 from public.workspace_members m
                 where m.user_id = auth.uid() and m.is_default)
  );

  return new_id;
end;
$$;

revoke all on function public.create_workspace(text) from public;
grant execute on function public.create_workspace(text) to authenticated;

-- ---------- 3. write policies ----------

-- Renaming a workspace: admins of that workspace only. No INSERT policy —
-- create_workspace() above is the only way in — and no DELETE policy, because
-- deleting a workspace cascades to every row a firm owns and should not be one
-- misplaced click in a web UI.
drop policy if exists "admins update their workspace" on public.workspaces;
create policy "admins update their workspace" on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));

-- Membership changes: admins of the workspace being changed. The WITH CHECK is
-- what stops an admin of workspace A from writing a membership row into
-- workspace B.
drop policy if exists "admins manage members" on public.workspace_members;
create policy "admins manage members" on public.workspace_members
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists "admins update members" on public.workspace_members;
create policy "admins update members" on public.workspace_members
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- Removal: an admin can remove anyone, and anyone can remove themselves (leave).
drop policy if exists "admins remove members" on public.workspace_members;
create policy "admins remove members" on public.workspace_members
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id) or user_id = auth.uid());

-- A workspace must never lose its last admin: nobody could then invite, rename,
-- or hand over, and only a database operator could repair it. Enforced as a
-- trigger rather than a policy because it is a statement about the table's
-- contents after the change, which a policy cannot express.
create or replace function public.assert_admin_remains()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(old.workspace_id, new.workspace_id);
begin
  -- The workspace itself being deleted cascades its members away, and a
  -- workspace that no longer exists does not need an admin. Without this, a
  -- legitimate `delete from workspaces` would fail with a confusing error
  -- about admins.
  if not exists (select 1 from public.workspaces w where w.id = target) then
    return null;
  end if;

  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = target and m.role = 'admin'
  ) then
    raise exception 'a workspace must keep at least one admin';
  end if;
  return null;
end;
$$;

drop trigger if exists workspace_members_keep_admin on public.workspace_members;
create constraint trigger workspace_members_keep_admin
  after update or delete on public.workspace_members
  deferrable initially deferred
  for each row execute function public.assert_admin_remains();

-- ---------- 4. invites ----------

-- Invites are by email because the invitee may not have an account yet, and a
-- workspace admin has no business reading auth.users to find out. The row is a
-- claim ticket: it grants nothing until the person actually signs in with that
-- address and claims it.
create table if not exists public.workspace_invites (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces(id) on delete cascade,
    email        text not null,
    role         text not null default 'member' check (role in ('admin','member','partner')),
    invited_by   uuid references auth.users(id) on delete set null,
    created_at   timestamptz not null default now(),
    accepted_at  timestamptz,
    accepted_by  uuid references auth.users(id) on delete set null
);

-- One live invite per (workspace, email). Partial, so a re-invite after the
-- first was accepted is allowed.
create unique index if not exists workspace_invites_pending_key
  on public.workspace_invites (workspace_id, lower(email))
  where accepted_at is null;

create index if not exists workspace_invites_email_idx
  on public.workspace_invites (lower(email)) where accepted_at is null;

alter table public.workspace_invites enable row level security;

-- Members can see who has been invited to their workspace; only admins can
-- create or withdraw an invite.
drop policy if exists "members read invites" on public.workspace_invites;
create policy "members read invites" on public.workspace_invites
  for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists "admins write invites" on public.workspace_invites;
create policy "admins write invites" on public.workspace_invites
  for insert to authenticated with check (public.is_workspace_admin(workspace_id));

drop policy if exists "admins withdraw invites" on public.workspace_invites;
create policy "admins withdraw invites" on public.workspace_invites
  for delete to authenticated using (public.is_workspace_admin(workspace_id));

-- Claiming: run for the signed-in user against their OWN verified email. The
-- caller cannot pass an address — it is read from the JWT — so this cannot be
-- used to claim someone else's invite by guessing their email.
create or replace function public.claim_workspace_invites()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := auth.uid();
  mail  text := lower(nullif(auth.jwt() ->> 'email', ''));
  taken int  := 0;
begin
  if me is null or mail is null then
    return 0;
  end if;

  with claimed as (
    update public.workspace_invites i
       set accepted_at = now(), accepted_by = me
     where lower(i.email) = mail
       and i.accepted_at is null
    returning i.workspace_id, i.role
  ), inserted as (
    insert into public.workspace_members (workspace_id, user_id, role, is_default)
    -- Always false here. Claiming two invites in one call would otherwise mark
    -- BOTH as default: the not-exists check would run against the
    -- pre-statement snapshot and be true for every row. The single default is
    -- settled once, below, where it can see the finished state.
    select c.workspace_id, me, c.role, false
      from claimed c
    -- Already a member: the invite is still consumed, but their existing role
    -- is not silently changed underneath them.
    on conflict (workspace_id, user_id) do nothing
    returning 1
  )
  select count(*) into taken from inserted;

  -- Give the user a default if they now have memberships but no default —
  -- their oldest, so it is stable rather than dependent on claim order.
  if not exists (select 1 from public.workspace_members m
                  where m.user_id = me and m.is_default) then
    update public.workspace_members
       set is_default = true
     where user_id = me
       and workspace_id = (
         select workspace_id from public.workspace_members
          where user_id = me order by created_at, workspace_id limit 1
       );
  end if;

  return taken;
end;
$$;

revoke all on function public.claim_workspace_invites() from public;
grant execute on function public.claim_workspace_invites() to authenticated;
