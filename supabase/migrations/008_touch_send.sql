-- 008_touch_send.sql
-- Send-layer tracking on touches: which provider sent it and the provider's id
-- for that lead/message, so reply/status webhooks can match back to the touch.

alter table public.touches add column if not exists provider     text
  check (provider in ('smartlead', 'heyreach'));
alter table public.touches add column if not exists provider_ref text;

create index if not exists touches_provider_ref_idx on public.touches (provider_ref);
