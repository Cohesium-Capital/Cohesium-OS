-- 034_seed_workspace_admins.sql  (tenancy, phase 3 — bootstrap)
--
-- 028 seeded every existing user into the Cohesium workspace using the column
-- default, which is 'member'. So after 033 introduced admin-only policies, the
-- workspace had NO admin: nobody could rename it, invite anyone, or manage
-- members, and the last-admin trigger could never fire because there was no
-- admin to protect. Phase 3's entire surface would have rendered and done
-- nothing.
--
-- ⚠️ THIS MIGRATION MAKES A JUDGEMENT CALL. Nothing in the data says who should
-- administer the firm: all five seeded accounts carry role 'member' both here
-- and in the legacy profiles table. It promotes the four `ripley@*` accounts —
-- the operator's own addresses across their domains — and deliberately leaves
-- the colleague account (matt@cohesium.co) as a member.
--
-- This grants NO new access to data. Every member already has full read/write on
-- every business table through the membership policies; admin adds only the
-- ability to rename the workspace, invite, and change roles. Narrowing or
-- widening it is a one-row update, and once the Settings surface ships it is a
-- click. Reviewing this list is worth a minute of the operator's time.

update public.workspace_members m
   set role = 'admin'
  from auth.users u
 where u.id = m.user_id
   and m.role <> 'admin'
   and lower(u.email) like 'ripley@%'
   -- Only the workspaces that existed before this migration; a workspace made
   -- later already got its creator as admin from create_workspace().
   and m.workspace_id in (
     select id from public.workspaces where created_at < now() - interval '1 minute'
   );

-- Fail loudly rather than leaving a workspace unadministerable. A workspace with
-- no admin is not a cosmetic problem: it cannot be repaired from the
-- application at all, only from a database session.
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
