-- wipe-dev-seed.sql : remove the fake demo data (seed-dev-data.sql) from DEV.
-- Keeps: settings, prompt_versions, the legacy batch row, profiles.
-- Idempotent: safe to run twice.

do $$
declare
  demo_batch uuid;
begin
  -- sourcing_runs reference seeded MSPs with on-delete-set-null; remove the log rows outright
  delete from public.sourcing_runs
  where target_msp_id in (select id from public.organizations where domain like '%.example');

  -- customer orgs first (their current_msp_id points at the seeded MSPs),
  -- then the MSPs. Cascades take out contacts -> touches/touch_edits,
  -- interactions -> extractions, grades, referrals.
  delete from public.organizations where domain like '%.example' and current_msp_id is not null;
  delete from public.organizations where domain like '%.example';

  -- demo run + batch
  select id into demo_batch from public.batches where label like 'demo:%' limit 1;
  if demo_batch is not null then
    delete from public.runs where batch_id = demo_batch;
    delete from public.batches where id = demo_batch;
  end if;

  raise notice 'wipe complete';
end $$;

-- verification: what remains
select 'organizations' as tbl, count(*)::int as rows from public.organizations
union all select 'contacts', count(*) from public.contacts
union all select 'touches', count(*) from public.touches
union all select 'interactions', count(*) from public.interactions
union all select 'extractions', count(*) from public.extractions
union all select 'sourcing_runs', count(*) from public.sourcing_runs
union all select 'runs', count(*) from public.runs
union all select 'batches', count(*) from public.batches
union all select 'grades', count(*) from public.grades
union all select 'prompt_versions', count(*) from public.prompt_versions
union all select 'settings', count(*) from public.settings
order by tbl;
