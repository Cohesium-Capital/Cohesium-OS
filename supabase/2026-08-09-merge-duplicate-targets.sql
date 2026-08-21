-- APPLIED TO PRODUCTION 2026-08-09. Kept as the record of an irreversible
-- change: it deleted two rows, and organizations has no soft-delete column.
-- Not a migration and not idempotent — the ids are specific to this incident,
-- and the guard block aborts rather than re-running.
--
-- Result: Ilium went 133 -> 131 targets with all 30 customers intact; the two
-- split client lists were reunited (TRA: Warrior Invictus + CuraLinc; Carnow:
-- Vistex + Warehouse Direct).
--
-- The cause is fixed in lib/sourcing/import-core.ts, which now resolves
-- provider names with nameKey. See that commit for why the two rules diverged.
--
-- Merge duplicated target companies in Ilium, created by the MSP-stub resolver
-- matching provider names with toLowerCase() instead of nameKey().
--
--   TRA    43f6a284 "The Retirement Advantage"      <- b445bfcf "…Advantage Inc"
--   Carnow cb2664cc "Carnow and Associates, Ltd"    <- d633b93f "…Ltd."
--
-- Winners: TRA by domain (tra401k.com + Port Washington WI, filled by the
-- Platform-100 import); Carnow by the cleaner name, the pair being otherwise
-- identical. Verified before writing: no contacts hang directly off either
-- loser, no sourcing_runs point at them, and the customers on each side are
-- DIFFERENT companies — so repointing cannot collide on the customer row
-- identity key (nameKey|current_msp_id).
--
-- organizations has no soft-delete column, so the loser is really deleted.
-- Explicit transaction: a partial merge would strand a customer on a row that
-- no longer exists.

begin;

create temp table merges (winner uuid, loser uuid) on commit drop;
insert into merges values
  ('43f6a284-7fe6-45d0-8022-49c139a2080f', 'b445bfcf-5a7d-4d89-ae60-c8cc587aae3a'),
  ('cb2664cc-0be4-4fd5-9dbc-ce4d78d91459', 'd633b93f-8efd-4aad-802f-fa0a50c3b4a9');

-- Guard: refuse to run if the shape is not what was verified. Any surprise here
-- means the data moved since the investigation and the merge must be re-checked.
do $$
declare n int;
begin
  select count(*) into n from public.organizations o join merges m on o.id in (m.winner, m.loser);
  if n <> 4 then raise exception 'expected 4 rows, found %', n; end if;

  select count(*) into n from public.contacts c join merges m on c.organization_id = m.loser;
  if n <> 0 then raise exception 'a loser has % contact(s) attached directly', n; end if;
end $$;

-- 1. Customers follow their provider.
update public.organizations c
   set current_msp_id = m.winner
  from merges m
 where c.current_msp_id = m.loser;

-- 2. Every remaining FK onto organizations (contacts, intro_paths,
--    sourcing_runs — the full set, from information_schema). All expected to be
--    no-ops here; written anyway so the merge is correct, not just correct today.
update public.contacts ct
   set organization_id = m.winner
  from merges m
 where ct.organization_id = m.loser;

update public.intro_paths ip
   set to_msp_id = m.winner
  from merges m
 where ip.to_msp_id = m.loser;

update public.sourcing_runs sr
   set target_msp_id = m.winner
  from merges m
 where sr.target_msp_id = m.loser;

-- 3. Keep anything the loser knew that the winner does not. Fills NULLs only,
--    the same rule the importer's merge path uses.
update public.organizations w
   set domain     = coalesce(w.domain,     l.domain),
       hq_city    = coalesce(w.hq_city,    l.hq_city),
       hq_state   = coalesce(w.hq_state,   l.hq_state),
       source_url = coalesce(w.source_url, l.source_url),
       evidence   = coalesce(w.evidence,'[]'::jsonb) || coalesce(l.evidence,'[]'::jsonb),
       updated_at = now()
  from merges m
  join public.organizations l on l.id = m.loser
 where w.id = m.winner;

-- 4. The duplicate is gone.
delete from public.organizations o using merges m where o.id = m.loser;

commit;

-- ---------- verification ----------
select 'after: surviving rows' as step, o.id, o.name, o.domain, o.hq_city, o.hq_state,
       (select count(*) from public.organizations c
         where c.current_msp_id = o.id and c.kind = 'customer') as customers
  from public.organizations o
  join public.workspaces w on w.id = o.workspace_id
 where w.name = 'Ilium Holdings'
   and (o.name ilike '%retirement advantage%' or o.name ilike '%carnow%')
 order by o.name;

select 'after: the four customers, now under two providers' as step,
       m.name as provider, c.name as customer
  from public.organizations c
  join public.organizations m on m.id = c.current_msp_id
  join public.workspaces w on w.id = c.workspace_id
 where w.name = 'Ilium Holdings'
   and (m.name ilike '%retirement advantage%' or m.name ilike '%carnow%')
 order by m.name, c.name;

select 'after: Ilium totals' as step,
       count(*) filter (where kind = 'msp')      as targets,
       count(*) filter (where kind = 'customer') as customers
  from public.organizations o
  join public.workspaces w on w.id = o.workspace_id
 where w.name = 'Ilium Holdings';
