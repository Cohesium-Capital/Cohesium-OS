-- 007_touch_drafts.sql
-- A planned outbound touch carries its drafted copy. (Supersedes the files4
-- draft 002_touch_message_body.sql, which was never applied.) 'approved' defaults
-- true so the send-selection grid sends to all unless you uncheck a row.

alter table public.touches add column if not exists subject  text;  -- email only
alter table public.touches add column if not exists body     text;
alter table public.touches add column if not exists approved boolean not null default true;

create index if not exists touches_status_idx on public.touches (status);
