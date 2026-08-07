# Session Handoff Brief — Cohesium-OS

Last updated: 2026-08-07. Purpose: full context for continuing work in a new
chat session. Read this top to bottom before doing anything.

> The previous edition of this file was written 2026-07-18 and went stale
> without anyone noticing — it described a `feature/learning-loop` branch and a
> four-phase roadmap that had all shipped, and it claimed we had no production
> database access, which stopped being true on 2026-07-29. **91 commits landed
> between that edition and this one.** If you are reading this more than a few
> weeks after the date above, check `git log` before trusting any of it.

## What this project is

Cohesium-OS is a customer-intelligence and acquisition engine: find acquisition
targets in a fragmented service market, learn how healthy they are by talking to
their customers, and run honest outreach at scale. Human-in-the-loop at every
stage.

It is now **multi-tenant**. The market vocabulary is per-workspace, not
hardcoded, so the same pipeline serves two different markets:

| Tenant | Market | Targets are called |
|---|---|---|
| **Cohesium** | managed IT services | MSPs |
| **Ilium Holdings** | retirement plan administration | TPAs |

The app's UI says "Target Companies" everywhere; only each tenant's *prompts*
speak its own vocabulary, rendered server-side from `workspace_profile.vocab`.
The database column is still `kind = 'msp'` and the persona key is still
`head_of_it` — those are schema CHECKs and JSON contract literals, deliberately
left alone. Don't "fix" them.

## The pipeline

**Source → Review & Enrich → Grade → Personalize → Draft → Send.**

An **eval gate** sits across it: each run opens a batch, contacts are sampled
for human grading, and a batch that fails its threshold blocks its contacts from
advancing. `reviewed = true` gates **Clay spend**; the **batch gate** is what
gates drafting. Those are two different controls and it matters which is which.

Sourcing runs two ways, producing identical rows, batches and attribution:

| | `copy_paste` | `runner` |
|---|---|---|
| Driver | you, pasting into Claude/ChatGPT | a Claude Code session |
| Avoids re-research by | exclusion list inside the prompt | asking the API per batch |
| Cap | **400 companies** | **none** |

`docs/RUNNER.md` explains the inversion that removes the cap and the token/RLS
security model. Read it before touching anything under `app/api/sourcing/`.

## Environments

| Thing | Value |
|---|---|
| Production app | <https://cohesium-os.vercel.app> (Vercel, auto-deploys on merge to `main`) |
| Repo | `Cohesium-Capital/Cohesium-OS`, default branch `main` |
| Merge convention | **PR + squash merge**, one commit per PR titled `… (#N)`. History is linear. |
| CI | `.github/workflows/test.yml` — `tsc --noEmit`, `npm test` against a **real Postgres service**, `eslint`. Runs on every PR and every push to `main`. |
| Tests | `npm test` in `web/` — 159 tests. **CI is the real check**: the 17 Postgres-backed workspace-isolation tests *skip* locally and CI fails the build if they do. |
| Prod DB access | **Yes**, since 2026-07-29. `PROD_DATABASE_URL` in `web/.env.local` (gitignored). |
| SQL runner (prod) | `cd web && npx tsx scripts/run-sql-prod.ts <file.sql>` — echoes target db/user before writing. |
| Dev Supabase | **No longer wired.** `.env.local` carries only `PROD_DATABASE_URL`; the old dev project is not referenced by any current config. There is no local dev database — assume anything you run touches production. |

### The dev-environment gap

This is the most important operational fact in this file. The previous handoff
described a dev Supabase project, a `DEV_DATABASE_URL`, and a wipe/reseed
workflow. **None of that is wired anymore.** `web/.env.local` was created to run
migration 044 against production and never grew back into a dev setup.

Consequences: there is currently no safe place to try a migration, and
`npm run dev` locally has no Supabase credentials. Standing a dev project back
up is unclaimed work and is the single best thing to do before the next
schema change.

## Migrations

`supabase/migrations/001…047`. Applied by hand, in filename order, via
`run-sql-prod.ts`. Every file is idempotent; on a lock timeout, re-run it.

Production is at **at least 047** — the Ilium tenant is live and in daily use,
which requires 028 (workspaces), 044 (Ilium seed) and 047 (customer-function
vocabulary). Verify rather than assume before applying anything new.

`docs/MERGE-MIGRATE-RUNBOOK.md` is the worked example of a careful prod
migration (preflight queries, invariant snapshot, expand-then-deploy ordering).
It was written for 014→020 but the *method* is the reusable part.

## Tenants

**Cohesium** — the operator workspace. Holds the environment sending
credentials; `identity.ts` deliberately refuses to let any other tenant fall
back to them.

**Ilium Holdings** — seeded by migration 044, vocabulary corrected by 047.
Admins: `ripley@cohesiumcap.com` (direct) and `saagar@iliumholdings.com` (via a
claimable admin invite). Its own firm identity, market vocabulary and worked
examples live in `workspace_profile`, editable in Settings.

**As of 2026-08-07 Ilium holds 118 retirement TPAs** as target companies,
imported from Saagar's Platform-100 research sheet (119 rows; one placeholder
row excluded). Companies and domains only — no contacts, deliberately. 17 are
flagged **unconfirmed** (16 with no usable domain, plus one the sheet records as
a non-independent division). Three of the 118 matched targets Ilium already had
and were merged rather than duplicated.

That import used the JSON/CSV paths on `/source/import`, not a sourcing run, so
nothing entered the Grade queue. **Next step for Ilium is sourcing customers for
those TPAs** — see "Open threads".

## Gotchas

- **If the UI looks inexplicably empty, check `profiles` first.** RLS returns
  zero rows with no error when a signed-in user has no `profiles` row. An auth
  trigger creates one on first sign-in, but accounts predating the trigger were
  missing it. Same symptom, same fix: backfill from `auth.users`.
- **Run npm from inside `web/`.** `cd` first; the shell tool's working-directory
  parameter is not enough. The package lives there, not at the repo root.
- **Merging to `main` deploys to production.** There is no staging gate.
- **The runner needs network access set to `full`** if it is a Claude Code
  session inside the Claude app. The failure is a DNS/connection error on the
  first request, with nothing in the app's logs — because the request never
  arrives.
- **A sourcing import with zero contacts leaves a permanently-open batch.**
  Gating happens on contacts; with none, the gate never resolves. Harmless
  (nothing is blocked) but it looks like a stuck batch forever.
- The legacy standalone Python core at the repo root (`extract.py`, `llm.py`,
  `schema.sql`, `prompts/`) is **not** part of the web app. `schema.sql` is
  still the base schema the migrations build on; the Python is vestigial.

## Docs

| File | What it covers |
|---|---|
| `docs/TUTORIAL.md` | how to use the pipeline, stage by stage |
| `docs/RUNNER.md` | the Claude Code runner: API, token/RLS model, setup |
| `docs/CLAY.md` | enrichment setup and the write-back contract |
| `docs/ONBOARDING.md` | standing up a new tenant's first admin |
| `docs/MERGE-MIGRATE-RUNBOOK.md` | worked method for a careful prod migration |
| `docs/FRESH-EYES-REDESIGN.md` | the redesign's reasoning |

## Open threads

1. **Source customers for Ilium's 118 TPAs.** The immediate work. Use
   `find_customers_for_msps`, **one TPA per run** — both the UI
   (`run-source-builder.tsx`) and the runner API
   (`app/api/sourcing/runs/route.ts`) set `targetMspId` only when exactly one
   target is selected, and that single id does double duty: it enables
   `new_for_target` yield accounting *and* scopes the known-check so a company
   already recorded under a different TPA still counts as new information. Pass
   several ids and you lose both.
2. **Stand a dev database back up** (see "The dev-environment gap").
3. **Known import limitations**, none urgent, all deliberate:
   - The CSV tab cannot carry contacts at all — `csvToPayloadJson` hardcodes
     `contacts: []`. Use the JSON tab when contacts matter.
   - Merge does not backfill onto an existing *contact*; a re-import will not
     add an email to someone already on file.
   - `optEmail` in `lib/contracts.ts` only checks for `@`, so `a@b` would pass
     the contract and reach the send path as a bounce.
   - Merge fills only null columns, so a pre-existing low-confidence stub keeps
     `confidence = 'low'` even after a good import fills in its domain.
4. **The sheet's metadata has no home.** Revenue, employee count, plan count,
   recordkeeper partners, succession signals, warm path and score do not exist
   in `organizations`. There is an unused `notes` column and nothing reads it.
   For now the spreadsheet stays system of record for ranking. Giving the app
   somewhere to put this is a real feature, not an import tweak.
