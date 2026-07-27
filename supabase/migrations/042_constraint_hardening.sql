-- 042_constraint_hardening.sql
--
-- Two constraint gaps from the tenancy review.
--
-- 1. grades' dedupe key never deduped legacy grades. The unique key is
--    (contact_id, field, run_id) with run_id nullable, and NULLs compare
--    distinct by default — so recordGrade's upsert with run_id null NEVER hit
--    the conflict and re-grading a legacy contact inserted a duplicate row
--    each time, double-counting errors in stage_health, batch gates and the
--    eval-set export. NULLS NOT DISTINCT makes null run_id one identity, which
--    is what "re-grading replaces" always meant.
--
-- 2. api_tokens.workspace_id was backfilled by 028 but never made NOT NULL,
--    and its policy never checked membership — a direct PostgREST insert could
--    mint a token naming a workspace the owner doesn't belong to (fails closed
--    downstream, but the "token acts in exactly one workspace" invariant lived
--    only in application code).

-- ---------- 1. grades ----------

-- Collapse any duplicates the old constraint admitted before tightening it:
-- keep the newest grade per (contact_id, field) among null-run rows — the
-- latest human verdict is the operative one.
delete from public.grades g
 using public.grades newer
 where g.run_id is null
   and newer.run_id is null
   and newer.contact_id = g.contact_id
   and newer.field = g.field
   and (newer.created_at > g.created_at
        or (newer.created_at = g.created_at and newer.id > g.id));

alter table public.grades
  drop constraint if exists grades_contact_id_field_run_id_key;
alter table public.grades
  add constraint grades_contact_id_field_run_id_key
  unique nulls not distinct (contact_id, field, run_id);

-- ---------- 2. api_tokens ----------

-- 028 backfilled every existing row; anything created since goes through
-- token-actions, which always stamps it. Belt-and-braces guard anyway:
update public.api_tokens
   set workspace_id = (select id from public.workspaces order by created_at, id limit 1)
 where workspace_id is null;

alter table public.api_tokens alter column workspace_id set not null;

-- Owner-only stays the rule (a token is a personal credential); the WITH
-- CHECK additionally requires the named workspace to be one the owner belongs
-- to, so a token can never be pinned to a foreign tenant.
drop policy if exists "api_tokens owner only" on public.api_tokens;
create policy "api_tokens owner only" on public.api_tokens
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id));
