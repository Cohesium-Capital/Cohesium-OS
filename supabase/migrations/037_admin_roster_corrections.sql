-- 037_admin_roster_corrections.sql  (tenancy — roster, as decided by the operator)
--
-- 034 made a judgement call it flagged for review: promote the four ripley@*
-- accounts, leave the colleague a member. The operator reviewed it and asked for
-- two changes.
--
-- 1. matt@cohesium.co becomes an admin.
-- 2. ripley@cohersiumcap.com — a typo of cohesiumcap.com — is removed entirely.
--
-- Checked before writing this: the typo account has NEVER signed in
-- (last_sign_in_at is null) and owns nothing — no api_tokens, no runs, no
-- sourcing_runs, no sending identity. Deleting it therefore orphans no data and
-- rewrites no history. If it is ever wanted back, signing up with that address
-- recreates it; nothing here is load-bearing.

-- Promote first, so the workspace is never momentarily short of admins while
-- the removal below runs.
update public.workspace_members m
   set role = 'admin'
  from auth.users u
 where u.id = m.user_id
   and lower(u.email) = 'matt@cohesium.co';

-- Remove the typo account. workspace_members and profiles both cascade from
-- auth.users, so this is the whole removal.
delete from auth.users where lower(email) = 'ripley@cohersiumcap.com';

-- Same guard as 034: never leave a workspace unadministerable.
do $$
declare orphan text;
begin
  select string_agg(w.name, ', ') into orphan
    from public.workspaces w
   where not exists (
     select 1 from public.workspace_members m
      where m.workspace_id = w.id and m.role = 'admin'
   );
  if orphan is not null then
    raise exception 'workspaces left with no admin: %', orphan;
  end if;
end $$;
