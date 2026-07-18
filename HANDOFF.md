# Session Handoff Brief — Cohesium-OS

Last updated: 2026-07-18 (evening, post-commit). Purpose: full context for
continuing work in a new chat session. Read this top to bottom before doing
anything.

## What this project is

Cohesium-OS is an MSP (managed IT service provider) customer-intelligence and
acquisition engine for Cohesium, an investment firm researching the managed IT
market. Two goals: (1) find MSP acquisition targets and gauge their health by
talking to their customers; (2) run honest outreach to those customers at scale.

- **Production app**: https://cohesium-os.vercel.app (Next.js on Vercel,
  Supabase project `cjquqgmxmkkorqplhsjl`). We do NOT have admin access to the
  production Supabase or the Vercel account that hosts it — only the public
  anon key (recovered from the JS bundle; it's public by design).
- **The pipeline** (5 steps, numbered in the app's sidebar):
  Source → Review → Grade → Draft → Send. Human-in-the-loop at every stage.
  Source and Draft use a copy-paste LLM workflow (copy prompt into
  Claude/ChatGPT, paste JSON back). An eval gate (sampled human grading,
  per-batch error thresholds) blocks batches from advancing.
- **Key dirs**: `web/` (Next.js app — the real system), `web/lib/grading/`
  (eval gate), `web/lib/runs/lifecycle.ts` (run lifecycle: createRun/ingestRun),
  `web/lib/modules/` (per-stage module registry), `supabase/migrations/`,
  `workflows/` (headless agent fan-out prompts), root `*.py` (legacy Python
  extraction core, standalone).

## Environments

| Thing | Value |
|---|---|
| Local dev server | http://localhost:3000 (`npm run dev` in `web/`, must run OUTSIDE sandbox — macOS sandbox blocks a syscall Next.js needs) |
| Git branch | `feature/learning-loop`, pushed to origin. Phase 1 committed as `78921d4`. Two untracked leftovers deliberately not committed: `supabase/setup-dev-db.sql`, `setup-dev-db-part2.sql` (one-off dev bootstrap, already applied) |
| DEV Supabase | project `stsjidclcinuahzstrxc` ("cohesium-dev") — full schema applied (schema.sql + migrations 003–014), safe to iterate |
| Credentials | all in `web/.env.local` (gitignored): anon key, `SUPABASE_SERVICE_ROLE_KEY` (dev), `SUPABASE_URL`, and `DEV_DATABASE_URL` (Postgres session-pooler conn string, password URL-encoded) |
| SQL runner | `cd web && set -a && source .env.local && set +a && npx tsx scripts/run-sql.ts <file.sql>` — executes any SQL file against dev via `DEV_DATABASE_URL` |
| Prod DB access | NONE. User chose not to copy prod data. Production untouched by all our work. |
| Tests | `npm test` in `web/` (Node built-in runner, 19 tests, all passing) |

Gotchas: a stray `~/package.json` in the home dir confuses npm — always run npm
from inside `web/` (cd first; the shell working_directory param is not enough).
Login to the local app = Supabase magic link; dev project's Site URL is
http://localhost:3000. The auth trigger auto-creates a profile with `member`
role (full access) on first sign-in.

## The two goals (user's words)

1. Overall workflow, UI, and UX optimization.
2. A recursive learning / continuous-improvement system for workflow, research
   output quality, message generation, and enrichment effectiveness.

## Key architectural finding (from codebase exploration)

A mature human-grading eval gate already exists (batches, grades,
prompt_versions, settings, deterministic sampling, gate thresholds), but the
learning loop never closed: touches (sent messages) had no link to the
run/prompt that produced them, draft edits were discarded, the eval-set JSONL
export has no automated consumer, and headless workflow imports bypass the eval
layer. Agreed phased roadmap:

- **Phase 1 — attribution plumbing (DONE, see below)**
- **Phase 2 — outcomes dashboard**: surface `draft_outcomes` (reply rates per
  prompt version / channel) in the app UI.
- **Phase 3 — draft grading + eval runner**: bring message text into the grade
  queue discipline; build the runner that replays the correction eval-set
  against revised prompts.
- **Phase 4 — UX flow polish**: merge/rename the two "review" concepts, surface
  enrichment as a pipeline step, next-action guidance, fix nav naming.

## Work completed on `feature/learning-loop` (committed & pushed, `78921d4`)

Phase 1 is code-complete, applied to dev DB, tests pass, verified end-to-end:

1. `supabase/migrations/014_touch_provenance.sql` (applied to DEV only):
   - `touches.run_id`, `touches.prompt_version_id` (+ indexes)
   - `touch_edits` table (human edit audit log: field, previous/new value,
     editor; RLS like the rest)
   - `touches.replied_at`, `touches.bounced_at`
   - `draft_outcomes` view: drafted/sent/replied/bounced/edited counts +
     reply_rate per prompt_version × channel
2. Provenance stamped at all three draft entry points:
   - `web/lib/drafting/import-core.ts`: `storeDrafts()` takes a provenance arg;
     `activeDraftPromptVersion()` helper resolves the active drafting prompt
   - `web/lib/drafting/import.ts` (paste flow), `web/lib/modules/drafting.ts` +
     `web/lib/runs/lifecycle.ts` (run lifecycle passes promptVersionId through
     IngestContext), `web/scripts/import-drafts-result.ts` (headless)
3. `web/lib/drafting/queue-actions.ts` `updateDraft()` logs before/after pairs
   to `touch_edits` (best-effort, non-blocking).
4. Reply/bounce timestamps set in all three outcome paths:
   `web/app/api/cron/email/route.ts`, `web/app/api/smartlead/route.ts`,
   `web/app/api/heyreach/route.ts`.

Also in that commit: `supabase/seed-dev-data.sql` (fake demo data, currently
loaded in the dev DB — about to be wiped, see next steps),
`web/scripts/run-sql.ts`, `pg`/`@types/pg` in web devDependencies, and this
handoff doc.

## IMMEDIATE NEXT STEPS (what we were about to do)

User decision: do NOT copy prod data; instead populate the dev DB with REAL
data by running the pipeline itself, with the agent (you) acting as the
research brain. Later, good data found in dev can be imported into prod.

1. **Wipe the fake seed data** from dev (orgs with `.example` domains and
   everything hanging off them, the demo batch/run/sourcing_runs). Keep
   settings, prompt_versions, and the legacy batch row.
2. **Research run — sourcing MSPs**: pick a region (seed data assumed VA/NC;
   confirm with user if unsure), find real MSPs via web search.
3. **Research run — customers per MSP**: for each MSP, real customers with
   evidence (case studies, client pages, review sites), real contacts with
   LinkedIn where findable, per the sourcing module's JSON contract
   (`web/lib/sourcing/`; JSON shape is in the seeded sourcing prompt v1 and
   `workflows/source-customers.workflow.js`).
4. **Ingest through the real pipeline**, not raw SQL: use
   `createRun`/`ingestRun` (`web/lib/runs/lifecycle.ts`) with a service-role
   client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are now in .env.local) so
   data lands in tracked runs/batches with sampling for the Grade queue.
   `web/scripts/import-workflow-result.ts` exists but bypasses the eval layer —
   prefer the run lifecycle; a small headless script that calls
   createRun+ingestRun is the way.
5. **User then grades the batch in the app** (/review/grade) — exercises the
   whole eval gate with real data.
6. After that: Phase 2 (outcomes dashboard surfacing `draft_outcomes` in the
   app UI).

Status when the last session ended: service-role key in place, research not
yet started (two web searches for VA/NC MSPs were kicked off but interrupted).
Nothing has been wiped or ingested yet — start at step 1.

## Deferred / open items

- Phase 1 migration (014) is NOT applied to production; when the branch ships,
  it must be applied deliberately (we have no prod DB access — the user or the
  infra owner runs it in the prod SQL editor).
- Whoever owns the production Vercel/Supabase accounts is still unknown to us;
  merging to main auto-deploys to prod (repo: Cohesium-Capital/Cohesium-OS).
- `web/scripts/verify-gate-p3.ts` and `verify-run-p2.ts` are prior verification
  scripts; `npm test` covers grading math.
- Auto-escalation (`shouldEscalate`) and `error_category` capture exist in
  schema/code but are unwired (candidate Phase 3 items).
- A PR can be opened anytime:
  https://github.com/Cohesium-Capital/Cohesium-OS/pull/new/feature/learning-loop
  — but do NOT merge to main until migration 014 has been applied to prod.
