-- 009_provider_smtp.sql
-- Allow 'smtp' as a touch provider (self-hosted email via cohesium.co).

alter table public.touches drop constraint if exists touches_provider_check;
alter table public.touches add constraint touches_provider_check
  check (provider in ('smartlead', 'heyreach', 'smtp'));
