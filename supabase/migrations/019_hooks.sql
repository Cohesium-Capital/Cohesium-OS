-- 019_hooks.sql
-- The personalization (hook research) stage's artifact. One row per researched
-- hook: a single verifiable claim about a contact (talk, news, post, award...)
-- with its source URL and dates — or an explicit kind='none' with an honest
-- fallback angle, so "no hook found" is a first-class outcome and the drafter
-- never faces the fabrication temptation. Hooks are sampled for human
-- verification (does the URL support THIS claim about THIS person, and is it
-- specific?) before drafting consumes them; touches.hook_id makes the
-- hooks-vs-fallback rent check computable from day one.

create table if not exists public.hooks (
    id                  uuid primary key default gen_random_uuid(),
    contact_id          uuid not null references public.contacts(id) on delete cascade,
    text                text,           -- the claim itself; null only when kind='none'
    source_url          text,
    source_published_at date,
    kind                text not null default 'other'
                          check (kind in ('talk','news','post','award','role_change','company_news','other','none')),
    fallback_angle      text,           -- honest role/industry opener when kind='none'
    track               text check (track in ('msp','customer')),
    run_id              uuid references public.runs(id),
    prompt_version_id   uuid references public.prompt_versions(id),
    batch_id            uuid references public.batches(id),
    sampled             boolean not null default false,
    status              text not null default 'candidate'
                          check (status in ('candidate','verified','rejected','expired','used')),
    verified_by         text,
    verified_at         timestamptz,
    reject_category     text,           -- mirrors grades.error_category values
    created_at          timestamptz not null default now(),
    -- A real hook needs its claim; only the explicit no-hook outcome may omit it.
    check (kind = 'none' or text is not null)
);

create index if not exists hooks_contact_idx on public.hooks (contact_id);
create index if not exists hooks_batch_idx on public.hooks (batch_id);
create index if not exists hooks_status_idx on public.hooks (status) where status in ('candidate','verified');

-- ---------- touches: which hook a message used ----------

alter table public.touches
  add column if not exists hook_id uuid references public.hooks(id);

create index if not exists touches_hook_idx on public.touches (hook_id);

-- ---------- grades: 'generic' joins the error taxonomy ----------
-- A generic-but-verifiable hook ("they have a website") games the
-- URL-supports-claim check; specificity failures need their own category.

alter table public.grades drop constraint if exists grades_error_category_check;
alter table public.grades add constraint grades_error_category_check
  check (error_category in ('stale_data','wrong_person','wrong_company','hallucinated',
                            'bad_evidence','formatting','misaligned_note','generic','other'));

-- ---------- hook_outcomes: the rent check ----------
-- Sent/replied/positive per hook kind (vs the no-hook arm), split by track.
-- If verified hooks don't beat fallback openers on positive replies within a
-- quarter, the stage folds back into drafting — this view is the kill
-- criterion's instrument.

create or replace view public.hook_outcomes
with (security_invoker = on) as
with reply_dispositions as (
  select touch_id,
         bool_or(disposition = 'positive') as has_positive
  from public.interactions
  where touch_id is not null and disposition is not null
  group by touch_id
)
select
  coalesce(h.kind, 'no_hook')                                 as hook_kind,
  t.track,
  count(*)                                                    as drafted,
  count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                      or t.sent_at is not null)               as sent,
  count(*) filter (where t.status = 'replied')                as replied,
  count(*) filter (where rd.has_positive)                     as positive_replied,
  round(
    count(*) filter (where rd.has_positive)::numeric
      / nullif(count(*) filter (where t.status in ('sent','delivered','replied','bounced')
                                   or t.sent_at is not null), 0),
    4)                                                        as positive_reply_rate
from public.touches t
left join public.hooks h on h.id = t.hook_id
left join reply_dispositions rd on rd.touch_id = t.id
where t.direction = 'outbound'
  and t.deleted_at is null
group by coalesce(h.kind, 'no_hook'), t.track;

-- ---------- RLS ----------

alter table public.hooks enable row level security;
drop policy if exists "members full access" on public.hooks;
create policy "members full access" on public.hooks
  for all to authenticated
  using (public.user_role() in ('admin', 'member'))
  with check (public.user_role() in ('admin', 'member'));
