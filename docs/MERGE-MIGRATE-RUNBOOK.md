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

---

# Multi-workspace tenancy (migrations 028–031)

**Status: phase 1 complete.** A second workspace is safe to create. Cohesium's
data lives in one workspace named `Cohesium`; nothing about the single-tenant
workflow changed.

## What "phase 1 complete" means

Every table that owns rows carries `workspace_id`, RLS gates it on membership,
and — since 031 — nothing supplies a default. A write that cannot name its
workspace fails. That failure is the feature: while 029's bridge defaults
existed, forgetting `workspace_id` filed the row somewhere plausible instead,
which is invisible until it is a cross-tenant leak.

Order matters if you ever rebuild this from scratch: **028** (columns + RLS +
per-workspace unique keys) → **029** (temporary defaults so prod keeps working)
→ **030** (views expose and group by `workspace_id`) → **031** (defaults dropped;
this is the finish line). Applying 028 without 029 breaks every INSERT
immediately.

## The rule for new code

Any INSERT into a root table must pass `workspace_id` explicitly:

- **Request-scoped code** (pages, server actions): `currentWorkspaceId()` from
  `lib/workspace/context` — the workspace on screen, validated against
  membership.
- **Pipeline code**: `ctx.workspaceId`, which the run carries. Never re-derive.
- **Background jobs with no session** (cron, webhooks): derive from the data —
  `workspaceOfContact()` / `workspaceOfTouch()` in `lib/workspace/resolve`. When
  there genuinely is nothing to derive from (an unresolvable bounce),
  `soleWorkspaceId()` is the honest fallback: it returns the only workspace and
  **throws once a second exists**, which is the signal that the job needs the
  per-workspace treatment phase 4 gives it.

Child tables (`grades`, `suppressions`, `touch_edits`, `gate_decisions`,
`enrichment_events`) have no `workspace_id`. They inherit through their parent
FK, and their RLS policies traverse it. Do not add the column to them.

`interactions` and `rejected_ingest` look like child tables but are roots: their
parent FKs are nullable, so an orphan row would otherwise be visible to nobody.

## Reads

Filtering by workspace is not optional on reads either, even though RLS bounds
them. RLS restricts to workspaces the user *belongs to* — for a member of two,
that is still both. Anything keyed `(workspace_id, module)` — `settings`,
`prompt_versions`, `prompt_rules`, `stage_health` — must filter explicitly, or a
`maybeSingle()` lookup matches two rows and silently falls back to a hardcoded
default.

## Verifying the invariant

```sql
-- Must be 0. Anything else means a default crept back in.
select count(*) from information_schema.columns
 where table_schema='public' and column_name='workspace_id'
   and column_default is not null;
```

`npm test` covers the rest: a member of one workspace cannot read or write
another's rows, and an insert naming no workspace is refused (by the RLS
`WITH CHECK`, before `NOT NULL` is even reached).

## Phases 2 and 3 (migrations 032–035)

**Phase 2 — identity and vocabulary.** `workspace_profile` holds a firm's name,
sender, approach sentence, market vocabulary, and the market-specific prose
blocks. It stores **overrides only**: a null column means "use the code default",
which is Cohesium's exact wording in `web/lib/workspace/identity.ts`. Cohesium
has no row and therefore cannot drift.

The 84 golden fixtures in `web/lib/prompts/__fixtures__` pin every prompt the
system renders. **When a prompt should change, re-capture them in the same
commit** — the diff is the review. When one changes unexpectedly, that is the
suite doing its job; it already caught a re-wrapped sentence that would have
forked `prompt_versions` for no behavioural gain.

Vocabulary is word-substituted. Prose is not: gold examples and persona angles
are written for one market, so a new workspace replaces the block wholesale via
`copy` (which supports `{{tokens}}`). Gold examples are editable in Settings;
the other blocks change only by migration.

Two vocabulary terms arrived later than the rest (`047`) because no prompt asked
for them until Ilium's read wrong, and the distinction they encode is the one to
keep straight when adding a third:

- `customerFunction` — the function inside a **prospect** that the provider is
  hired to carry ("IT" / "HR or benefits"). It names the second persona. The
  persona KEY stays `head_of_it` in every market: schema CHECK and contract
  literal, like `mspIds`.
- `providerCasual` — how a customer casually names the provider they hired
  ("IT provider" / "TPA"). Distinct from `providerGeneric` only because the
  prompts already said the shorter thing, and reusing the existing key would have
  moved Cohesium's bytes for no gain.

Articles follow the vocabulary too (`articleFor`): "an MSP" but "a TPA", read
from the first letter's NAME for an initialism. Hardcoding "an" is what put
"an TPA" through every Ilium prompt.

**Phase 3 — administration.** Creating a workspace goes through the
`create_workspace()` function, never a direct insert, so the workspace and its
creator's admin membership land together. Invites are claim tickets keyed on
email; `claim_workspace_invites()` matches the caller's own JWT and runs on every
Settings load. A deferred trigger refuses to remove or demote the last admin.

Two corrections in 035 are worth remembering, because both were invisible to
review and only showed up when probed:

- A policy **named** for admins tested `is_workspace_member`, so any member could
  rename the firm — and adding a correct policy alongside it changed nothing,
  because **permissive policies OR together**. Always drop the old policy by its
  exact name, and verify by attempting the action as the lesser role.
- `workspace_profile` shipped member-writable while the app assumed admin-only.
  The application is never the boundary; the database is.

## Phase 4 — sending identities (migration 036)

`sending_identity` holds who a workspace sends as, per workspace and optionally
per user. **The environment variables remain the last resort**, which is what
makes this invisible to Cohesium: it has configured nothing, so every lookup
falls through to the same `SMTP_*` / `MAIL_FROM` / `HEYREACH_*` values as before.

**Credentials live in `sending_secret`, which has RLS enabled and no policy for
`authenticated` at all.** That is the mechanism, not an oversight: with RLS on
and no policy, PostgreSQL denies everything, so no browser session can read an
SMTP password — verified against production with an *admin* session, which sees
zero rows there while the identity itself stays visible. The cron reads it as
`service_role`. Writes go through `set_sending_secret()`, which checks admin,
treats a null argument as "leave that one alone", and never returns a value.

Consequence worth knowing: any server-side code that needs a credential must use
the **service-role** client, not the user's. `sendApproved` learned this the hard
way — with the user's client the API key comes back null and a workspace that
configured its own key looks permanently unconfigured. It is a server action, so
the key is read and used on the server and never reaches the client.

HeyReach takes a `linkedInAccountId` **per lead pair**, so two people in one
workspace can send from their own accounts in a single call. The campaign falls
back to the workspace's; the account never does.

An incomplete identity leaves touches **queued**, not failed — a missing
password is fixable config, and burning a firm's drafts over it is the wrong
trade.

## Still to come

- ~~**Reply capture is still single-mailbox.**~~ **Done.** Capture now loops the
  configured identities: every `sending_identity` naming an inbox is polled, and
  what it captures files under that identity's workspace. The env mailbox belongs
  to the **operator workspace** — the oldest one — and to nobody else, the same
  gate the send path uses.

  Capture-before-send survives, per inbox rather than per instance, and the
  keying is the part worth remembering: `capturedOk` is keyed on **inbox
  (host|user), not workspace**, because since `043` a personal mailbox follows
  its owner across workspaces, which makes "was this workspace's inbox captured?"
  ill-formed. The send loop asks "was the inbox the RESOLVED IDENTITY sends from
  captured this run?" so the two sides key on the same thing.

  Consequence for a new tenant: **a workspace with no inbox cannot send at all.**
  It cannot see an opt-out sitting in the mail, so its sends are held with an
  error naming the fix. An SMTP-only identity is therefore a mailbox that never
  sends — configure IMAP with it, or neither.
- The `copy` blocks are **partly** editable now: `037`'s worked-examples panel
  edits `goldCustomer` and `goldMsp`. The rest — persona angles, perspectives,
  subject shapes — still have no UI and change only by migration.
- ~~`034` promoted the four `ripley@*` accounts to workspace admin.~~ Reviewed
  and settled in `037`: `matt@cohesium.co` is an admin, and the typo account
  `ripley@cohersiumcap.com` was removed outright — it had never signed in and
  owned nothing. Four admins remain.
