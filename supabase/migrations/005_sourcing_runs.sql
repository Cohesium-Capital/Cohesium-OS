-- 005_sourcing_runs.sql
-- A log of every import, so we can measure sourcing yield over time. A "targeted"
-- run (target_msp_id set) records how many NEW customers it added for that MSP
-- (new_for_target). The MSP dashboard reads this to auto-judge when an MSP is
-- tapped out: a single targeted run that adds 0 new customers => exhausted.

create table if not exists public.sourcing_runs (
    id                 uuid primary key default gen_random_uuid(),
    kind               text not null check (kind in ('msp', 'customer')),
    target_msp_id      uuid references public.organizations(id) on delete set null,
    requested          int,
    inserted_orgs      int not null default 0,
    inserted_contacts  int not null default 0,
    skipped_duplicates int not null default 0,
    new_for_target     int,            -- new customers attributed to target_msp_id; null when untargeted
    created_by         uuid references auth.users(id),
    created_at         timestamptz not null default now()
);

create index if not exists sourcing_runs_target_idx on public.sourcing_runs (target_msp_id);
create index if not exists sourcing_runs_created_idx on public.sourcing_runs (created_at);

alter table public.sourcing_runs enable row level security;

drop policy if exists "members full access" on public.sourcing_runs;
create policy "members full access" on public.sourcing_runs
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));
