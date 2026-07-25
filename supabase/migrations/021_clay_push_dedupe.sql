-- 021_clay_push_dedupe.sql
-- Never pay Clay twice for the same contact.
--
-- Clay eligibility keyed on enrichment_status='pending', and neither the push
-- nor the CSV export changed that status (by design — only Clay's write-back
-- flips it). So a contact Clay found nothing for, or never wrote back on, stayed
-- 'pending' forever and was re-sent — and re-billed — on every subsequent push.
--
-- clay_pushed_at is the durable "we already spent on this one" mark, stamped by
-- both send paths (webhook push and CSV export). Eligibility now requires it to
-- be NULL; a deliberate re-send clears it.

alter table public.contacts
  add column if not exists clay_pushed_at timestamptz;

-- Eligibility filters on IS NULL alongside enrichment_status/reviewed, so the
-- useful index is the partial one over rows still awaiting a push.
create index if not exists contacts_clay_unpushed_idx
  on public.contacts (enrichment_status)
  where clay_pushed_at is null and deleted_at is null;

-- Backfill from the provenance we already recorded: every contact with a
-- 'pushed' enrichment_event has been sent to Clay at least once. Without this,
-- the first push after deploy would re-send the entire existing backlog.
update public.contacts c
   set clay_pushed_at = e.last_pushed
  from (
    select contact_id, max(created_at) as last_pushed
      from public.enrichment_events
     where event = 'pushed'
     group by contact_id
  ) e
 where e.contact_id = c.id
   and c.clay_pushed_at is null;

-- Contacts that already carry a Clay result predate enrichment_events (the CSV
-- export never recorded provenance at all). They are unambiguously spent, so
-- mark them from their status rather than leaving them re-pushable.
update public.contacts
   set clay_pushed_at = coalesce(clay_pushed_at, now())
 where clay_pushed_at is null
   and enrichment_status in ('enriched', 'failed', 'low_confidence');

comment on column public.contacts.clay_pushed_at is
  'When this contact was last sent to Clay (webhook push or CSV export). NULL = never sent; set = credits already spent, excluded from the eligible set unless a re-send is explicitly requested.';
