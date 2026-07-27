-- 035_tighten_workspace_policies.sql  (tenancy, phase 3 — corrections)
--
-- Two policies granted more than their names claimed. Both were found by
-- probing the actual behaviour of 033 rather than by reading it, which is the
-- only way this class of bug shows up: PostgreSQL ORs permissive policies
-- together, so ADDING a stricter policy never removes access granted by a
-- looser one that is still in place.

-- ---------- 1. a policy called "admins" that only checked membership ----------
--
-- 028 created "admins update their workspaces" (plural) with the predicate
-- is_workspace_member(id). So any member could rename the firm. 033 then added
-- "admins update their workspace" (singular) with the correct
-- is_workspace_admin(id) — but the near-identical name meant its
-- `drop policy if exists` did not remove the old one, and the two ORed
-- together to exactly the old, looser rule.
--
-- Verified before writing this: as a plain member, `update workspaces set name`
-- reported 1 row changed.
drop policy if exists "admins update their workspaces" on public.workspaces;

-- ---------- 2. the prompt profile was member-writable ----------
--
-- 032 gave workspace_profile the same blanket "workspace members" policy every
-- data table has. That is right for data and wrong for this table: its contents
-- are rendered verbatim into every outbound message, so changing it changes
-- what the firm says to strangers under its own name. The application already
-- restricted this to admins, but the database did not — and the database is
-- where it has to hold, since the application is not the only way in.
drop policy if exists "workspace members" on public.workspace_profile;

create policy "members read the profile" on public.workspace_profile
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "admins write the profile" on public.workspace_profile
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

create policy "admins update the profile" on public.workspace_profile
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- Deleting the row is how "reset to defaults" is implemented, so it is the same
-- privilege as editing it.
create policy "admins reset the profile" on public.workspace_profile
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));
