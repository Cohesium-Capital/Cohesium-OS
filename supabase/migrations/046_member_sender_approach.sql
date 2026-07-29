-- 046_member_sender_approach.sql
--
-- "Why you're reaching out" (the approach) follows the same scoping as the
-- intro: a tenant default (workspace_profile.approach, admin-set) that each
-- member may override for themselves within the workspace. member_sender gained
-- the name and intro overrides in 045; this adds the approach override.
--
-- Additive and idempotent.

alter table public.member_sender
  add column if not exists approach text;

-- ---------- verification ----------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'member_sender'
 order by ordinal_position;
