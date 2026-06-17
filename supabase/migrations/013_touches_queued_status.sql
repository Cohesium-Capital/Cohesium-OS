-- The email drip queues approved touches as 'queued' (lib/send/send.ts) and the
-- cron worker (/api/cron/email) sends from that state. The original
-- touches_status_check predated the drip and omitted 'queued', so queuing emails
-- failed with: new row for relation "touches" violates check constraint
-- "touches_status_check". Add 'queued' to the allowed set.

alter table public.touches drop constraint if exists touches_status_check;

alter table public.touches
  add constraint touches_status_check
  check (status in ('planned','queued','sent','delivered','bounced','replied','failed'));
