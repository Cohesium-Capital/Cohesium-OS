-- 038_access_requests.sql  (onboarding — ask for access, get approved, get a tenant)
--
-- Today a stranger who enters their email on /login receives a magic link,
-- signs in, and hits a dead end: the layout checks ALLOWED_EMAILS, finds them
-- missing, and offers them a Sign out button. Nobody is told they tried. The
-- only way in is for someone to edit an environment variable in Vercel and
-- redeploy.
--
-- This makes the dead end a front door. A signed-in user with no workspace can
-- record a request; the operator is emailed, approves in Settings, and approval
-- provisions a NEW workspace with them as its admin — their own tenant, not a
-- seat in someone else's.
--
-- Note what this deliberately does NOT change: a pending or denied requester can
-- already see nothing at all. Every table is gated on workspace membership
-- (028), so an account with no membership reads zero rows no matter what the
-- application does. This table is about communication and provisioning, not
-- about access control — the access control already holds.

create table if not exists public.access_requests (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null unique references auth.users(id) on delete cascade,
    email       text not null,
    full_name   text,
    firm_name   text,
    note        text,
    status      text not null default 'pending' check (status in ('pending','approved','denied')),
    created_at  timestamptz not null default now(),
    decided_at  timestamptz,
    decided_by  uuid references auth.users(id) on delete set null,
    decision_note text,
    -- The workspace created for them on approval, so a second approval cannot
    -- silently mint a second tenant for the same person.
    workspace_id uuid references public.workspaces(id) on delete set null
);

create index if not exists access_requests_pending_idx
  on public.access_requests (created_at) where status = 'pending';

-- ---------- who decides ----------
--
-- There is no global "instance admin" role: profiles.role predates tenancy and
-- every account currently carries 'member', so it says nothing about who runs
-- the deployment. The honest definition is the one the data already supports —
-- an admin of the FIRST workspace is the person who runs this instance.
create or replace function public.is_instance_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.workspace_members m
     where m.user_id = auth.uid()
       and m.role = 'admin'
       and m.workspace_id = (select id from public.workspaces order by created_at limit 1)
  )
$$;

revoke all on function public.is_instance_operator() from public;
grant execute on function public.is_instance_operator() to authenticated, service_role;

alter table public.access_requests enable row level security;

-- You can see and create your own request; the operator sees and decides all.
drop policy if exists "own request" on public.access_requests;
create policy "own request" on public.access_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_instance_operator());

drop policy if exists "create own request" on public.access_requests;
create policy "create own request" on public.access_requests
  for insert to authenticated
  -- The email is taken from the JWT by the application, but pin the user_id
  -- here too: a request that names someone else is not a request, it is a
  -- forgery.
  with check (user_id = auth.uid());

drop policy if exists "requester updates own pending request" on public.access_requests;
create policy "requester updates own pending request" on public.access_requests
  for update to authenticated
  -- Only while still pending, and the decision fields are guarded by the
  -- trigger below rather than by column privileges, which policies cannot
  -- express.
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'pending');

drop policy if exists "operator decides" on public.access_requests;
create policy "operator decides" on public.access_requests
  for update to authenticated
  using (public.is_instance_operator())
  with check (public.is_instance_operator());

-- A requester may edit their own name/firm while waiting, but must not be able
-- to approve themselves by writing status. The UPDATE policy above lets them
-- write the row; this decides which COLUMNS they may actually move.
create or replace function public.guard_access_request_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_instance_operator() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.workspace_id is distinct from old.workspace_id
     or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at then
    raise exception 'only the operator can decide an access request';
  end if;
  return new;
end;
$$;

drop trigger if exists access_requests_guard_decision on public.access_requests;
create trigger access_requests_guard_decision
  before update on public.access_requests
  for each row execute function public.guard_access_request_decision();

-- ---------- approval provisions a tenant ----------
--
-- create_workspace() makes the CALLER the admin, which is exactly wrong here:
-- the operator is approving someone ELSE. This is the same two-statement
-- atomicity argument as 033 — the workspace and its admin membership must land
-- together, or the new firm gets a workspace nobody can see.
create or replace function public.approve_access_request(
  p_request_id uuid,
  p_workspace_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  req    public.access_requests;
  new_id uuid;
  clean  text := nullif(btrim(p_workspace_name), '');
begin
  if not public.is_instance_operator() then
    raise exception 'only the operator can approve access requests';
  end if;

  select * into req from public.access_requests where id = p_request_id;
  if req is null then
    raise exception 'no such access request';
  end if;
  if req.status = 'approved' then
    -- Idempotent rather than an error: a double-click must not mint a second
    -- tenant for the same person.
    return req.workspace_id;
  end if;

  if clean is null then
    clean := coalesce(nullif(btrim(req.firm_name), ''), split_part(req.email, '@', 2));
  end if;

  insert into public.workspaces (name) values (clean) returning id into new_id;

  insert into public.workspace_members (workspace_id, user_id, role, is_default)
  values (new_id, req.user_id, 'admin',
          not exists (select 1 from public.workspace_members m
                       where m.user_id = req.user_id and m.is_default));

  update public.access_requests
     set status = 'approved',
         decided_at = now(),
         decided_by = auth.uid(),
         workspace_id = new_id
   where id = p_request_id;

  return new_id;
end;
$$;

revoke all on function public.approve_access_request(uuid, text) from public;
grant execute on function public.approve_access_request(uuid, text) to authenticated;
