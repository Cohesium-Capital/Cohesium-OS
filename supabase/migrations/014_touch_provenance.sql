-- 014_touch_provenance.sql
-- Phase 1 of the learning loop: make every outbound message traceable to the
-- run and prompt version that produced it, log human edits as quality signals,
-- and stamp outcome timestamps — so reply rates can be computed per prompt
-- version, channel, and persona.
--
-- Three pieces:
--   1. Provenance columns on touches (run_id, prompt_version_id).
--   2. touch_edits: an audit log of human edits to draft copy. An edit is an
--      implicit "the AI draft wasn't good enough" signal — the previous/new
--      pair is eval-set material, same shape as grades corrections.
--   3. Outcome timestamps (replied_at, bounced_at) + the draft_outcomes view
--      aggregating the funnel per prompt version.

-- ---------- 1. provenance on touches ----------

alter table public.touches
  add column if not exists run_id            uuid references public.runs(id),
  add column if not exists prompt_version_id uuid references public.prompt_versions(id);

create index if not exists touches_run_idx on public.touches (run_id);
create index if not exists touches_prompt_version_idx on public.touches (prompt_version_id);

-- ---------- 2. touch_edits (human edits = implicit quality grades) ----------

create table if not exists public.touch_edits (
    id             uuid primary key default gen_random_uuid(),
    touch_id       uuid not null references public.touches(id) on delete cascade,
    field          text not null check (field in ('subject', 'body')),
    previous_value text,
    new_value      text,
    editor         text not null,              -- email or 'system'
    created_at     timestamptz not null default now()
);

create index if not exists touch_edits_touch_idx on public.touch_edits (touch_id);

alter table public.touch_edits enable row level security;

drop policy if exists "members full access" on public.touch_edits;
create policy "members full access" on public.touch_edits
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));

-- ---------- 3. outcome timestamps ----------
-- status already tracks replied/bounced, but transitions overwrite each other
-- and carry no time. Timestamps make time-to-reply and rate windows computable.

alter table public.touches
  add column if not exists replied_at timestamptz,
  add column if not exists bounced_at timestamptz;

-- ---------- 4. draft_outcomes view ----------
-- The scoreboard for the learning loop: per prompt version (plus a null row for
-- legacy/unattributed touches), how drafts moved through the funnel.
-- security_invoker = on so RLS applies to the querying user.

create or replace view public.draft_outcomes
with (security_invoker = on) as
select
  t.prompt_version_id,
  pv.module,
  pv.version,
  t.channel,
  count(*)                                                    as drafted,
  count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                      or t.sent_at is not null)               as sent,
  count(*) filter (where t.status = 'replied')                as replied,
  count(*) filter (where t.status = 'bounced')                as bounced,
  count(distinct e.touch_id)                                  as edited,
  round(
    count(*) filter (where t.status = 'replied')::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as reply_rate,
  min(t.sent_at)                                              as first_sent_at,
  max(t.sent_at)                                              as last_sent_at
from public.touches t
left join public.prompt_versions pv on pv.id = t.prompt_version_id
left join public.touch_edits e on e.touch_id = t.id
where t.direction = 'outbound'
group by t.prompt_version_id, pv.module, pv.version, t.channel;
