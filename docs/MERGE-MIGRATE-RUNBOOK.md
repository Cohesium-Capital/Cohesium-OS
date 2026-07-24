# Merge & migrate runbook — redesign/demo-v1 → main → prod

*Produced by the pre-merge review (2026-07-24): three independent audits — branch
merge/semantic conflicts, migration safety against prod data, dev-schema parity.
All three returned SAFE-WITH-ACTIONS; the actions are this runbook.*

## Review verdicts

| Audit | Verdict | Headline |
|-------|---------|----------|
| Branch merge vs `main@812aadc` | SAFE — **resolved & pushed** (`9d23f82`) | One textual conflict in `send.ts`, combined resolution applied (branch's cap + queued semantics, main's `sentCount` partial marking); `reconcile-heyreach.ts` retrofitted for redesign semantics |
| Migrations 014→020 on prod data | SAFE-WITH-ACTIONS | Additive, order-verified, idempotent; cannot fail on real-data conditions; **018 is the only row-mutating statement** (lowercases `contacts.email`) |
| Dev-schema parity | SAFE | Live dev schema is an **exact match** for the committed files, zero drift; real research data (19 orgs / 16 contacts) intact and untouched |

## Phase 0 — before merging (prod still on main)

1. **Run the HeyReach reconcile once, from main:** `npx tsx --env-file=.env.local scripts/reconcile-heyreach.ts` (dry run, then `--apply`). It exists to clear pre-fix stragglers and its original semantics match prod's current code. (The branch's retrofitted version is for post-merge use only.)
2. **Vercel preview settings for the demo** (dashboard — two minutes, both verified from outside as *unknown*, so check them explicitly):
   - **Env scoping**: the Preview environment must use the **dev** Supabase project (`stsjidclcinuahzstrxc`). If the project's vars are scoped "All Environments," the preview inherits **production** keys — the demo would then be graded, drafted and triaged against real prod data on a schema that lacks 014–020. Scope the dev values to Preview explicitly.
   - **`CLAY_TABLE_WEBHOOK_URL` unset** for Preview (the Clay table is production).
   - **Deployment protection**: the preview URL currently redirects to Vercel SSO, so teammates without Vercel accounts on this project cannot open it. Either add them to the Vercel team, switch the branch's protection to a shareable link / bypass token, or run the demo by screen-share from a local dev server.

## Phase 1 — migrate prod (expand; old code keeps running)

**Backup:** confirm PITR is enabled, or `pg_dump -Fc --schema=public <prod> -f prod-pre-014.dump`. Record the timestamp.

**Preflight (read-only, run in prod SQL editor):**

```sql
-- 1. Prod is really at 013 (touches has 'queued'; no 014 objects):
select pg_get_constraintdef(oid) from pg_constraint where conname = 'touches_status_check';
select to_regclass('public.touch_edits');            -- expect NULL
-- 2. Only the two known views exist (016/019 create the others):
select viewname from pg_views where schemaname = 'public';  -- expect msp_stats, batch_stats
-- 3. Rows 018 will rewrite, and post-lowercase logical duplicates:
select count(*) from contacts where email is not null and email <> lower(email);
select lower(email) e, count(*) c, array_agg(id) from contacts
  where email is not null group by 1 having count(*) > 1;
-- 4. No grades row can violate 019's constraint swap:
select coalesce(error_category,'<null>') cat, count(*) from grades group by 1;
-- 5. Invariant snapshot (compare after):
select approved, count(*) from touches group by 1;
select (select count(*) from contacts), (select count(*) from touches),
       (select count(*) from interactions), (select count(*) from grades),
       (select count(*) from runs), (select count(*) from prompt_versions);
```

**Apply:** pause the email cron (Vercel cron toggle) → apply `supabase/migrations/014 … 020` **strictly in filename order**, one session, from the `supabase/migrations/` files only (**never** `setup-dev-db*.sql` — those bootstrap fresh dev projects). Every file is idempotent: on a lock timeout, just re-run it.

**Post-migration:** re-run the snapshot queries (counts must be identical; only `contacts.email` casing changed, matching the preflight count) → confirm `draft_outcomes` + `hook_outcomes` select cleanly → resume the cron.

Why this is safe under old code: every column is nullable-or-default, new CHECKs ride on new (all-NULL) columns, the partial unique indexes cover zero existing rows, main sets `touches.approved` explicitly on every insert (default flip is inert), and nothing on main references `draft_outcomes`.

## Phase 2 — merge & deploy

1. Merge the PR (branch already carries `origin/main`; GitHub shows it mergeable).
2. **At cutover, re-run 018's UPDATE once** — old code may have written mixed-case emails during the expand window:
   `update contacts set email = lower(email) where email is not null and email <> lower(email);`
3. Set the new env vars on prod: `LINKEDIN_DAILY_CAP` (default 20), `ENRICHMENT_WEBHOOK_SECRET` (write-back endpoint must not stay open), confirm `CRON_SECRET`, IMAP/SMTP vars.
4. Smoke-test: send-queue approve → cron run (poll-first, suppression check) → Outcomes renders; HeyReach SENT webhook flips queued→sent.

## Rollback story

There is no DB rollback because none is needed: migrations are additive and inert under old code. Code rollback = revert the merge commit; the schema stays. The demo-phase rollback is simpler still: don't merge.
