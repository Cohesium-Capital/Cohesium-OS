# Session Handoff Brief — Cohesium-OS

Last updated: 2026-07-18 (late evening). Purpose: full context for continuing
work in a new chat session. Read this top to bottom before doing anything.

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
| Local dev server | http://localhost:3000 (`npm run dev` in `web/`, must run OUTSIDE sandbox — macOS sandbox blocks a syscall Next.js needs). RUNNING as of end of last session. |
| Git branch | `feature/learning-loop`, pushed to origin. Phase 1 = `78921d4`; headless ingest + real data = `04b3c4b`. Two untracked leftovers deliberately not committed: `supabase/setup-dev-db.sql`, `setup-dev-db-part2.sql` (one-off dev bootstrap, already applied) |
| DEV Supabase | project `stsjidclcinuahzstrxc` ("cohesium-dev") — full schema applied (schema.sql + migrations 003–014), safe to iterate |
| Credentials | all in `web/.env.local` (gitignored): anon key, `SUPABASE_SERVICE_ROLE_KEY` (dev), `SUPABASE_URL`, and `DEV_DATABASE_URL` (Postgres session-pooler conn string, password URL-encoded) |
| SQL runner | `cd web && set -a && source .env.local && set +a && npx tsx scripts/run-sql.ts <file.sql>` — executes any SQL file against dev via `DEV_DATABASE_URL` |
| Headless ingest | `cd web && set -a && source .env.local && set +a && npx tsx scripts/run-ingest.ts --module sourcing --label "..." --config c.json --payload p.json` — createRun+ingestRun with the service client (batch, provenance, sampling, evidence gate). Prefer over `import-workflow-result.ts` (bypasses eval layer). |
| Prod DB access | NONE. User chose not to copy prod data. Production untouched by all our work. |
| Tests | `npm test` in `web/` (Node built-in runner, 19 tests, all passing) |

Gotchas:
- A stray `~/package.json` in the home dir confuses npm — always run npm from
  inside `web/` (cd first; the shell working_directory param is not enough).
- Login to the local app = Supabase magic link; dev project's Site URL is
  http://localhost:3000. The auth trigger auto-creates a profile with `member`
  role on first sign-in — BUT the user's auth account predated the trigger, so
  their profile row was missing and RLS silently returned zero rows everywhere
  (empty UI, no errors). Fixed by backfilling `profiles` from `auth.users`.
  If the UI ever looks inexplicably empty: check `profiles` first.
- Shell tool: DB access needs `full_network`/`all` permission (pooler port is
  outside the sandbox allowlist).

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

- **Phase 1 — attribution plumbing (DONE, `78921d4`)**: migration 014
  (`touches.run_id/prompt_version_id/replied_at/bounced_at`, `touch_edits`
  audit table, `draft_outcomes` view); provenance stamped at all three draft
  entry points; `updateDraft()` logs edits; reply/bounce timestamps set in all
  three outcome paths (cron/email, smartlead, heyreach webhooks).
- **Phase 2 — outcomes dashboard (NEXT)**: surface `draft_outcomes` (reply
  rates per prompt version / channel) in the app UI.
- **Phase 3 — draft grading + eval runner**: bring message text into the grade
  queue discipline; build the runner that replays the correction eval-set
  against revised prompts.
- **Phase 4 — UX flow polish**: merge/rename the two "review" concepts, surface
  enrichment as a pipeline step, next-action guidance, fix nav naming.

## Work completed this session (committed & pushed, `04b3c4b`)

The dev DB now holds REAL researched data, ingested through the real pipeline:

1. **Wiped the fake seed data** (`supabase/wipe-dev-seed.sql`, idempotent).
   Kept settings (4), prompt_versions (2), the legacy batch row.
2. **New `web/scripts/run-ingest.ts`** — the headless eval-layer-respecting
   ingest path (see Environments table for usage).
3. **Run 1 — 9 real VA/NC MSP acquisition targets** (batch "VA/NC MSP
   acquisition targets (agent research)"): NDSE, Bastionpoint, CodeBlue,
   Hermetic Networks (Richmond metro), E-N Computers (Waynesboro), WingSwept
   (Garner), Net Friends (Durham), Sterling Technology Solutions + Charlotte
   IT Solutions (Charlotte). Every row has a source_url; leaders named where
   verifiable. Note: Sterling was acquired by Evergreen/Lyra May 2025.
4. **Run 2 — 10 real customers** linked to those MSPs (batch "Customers of
   VA/NC MSPs (agent research)"), from case studies/testimonials: 6 Net
   Friends clients (CAHEC, Curie Co, Atlantic Fertility, Emily K Center,
   Peak Swirles & Cavallito, TEAM Inc.), Jetton & Meredith (Sterling),
   University Eye Associates + TVsetdesigns.com (Charlotte IT Solutions),
   Jani-King RDU → WingSwept (deliberately low-confidence row).
5. Payloads/configs preserved in `dev-data/run*.json`. Verification queries in
   `supabase/verify-ingest.sql`. Both runs `review_ready`, both batches `open`,
   all 19 orgs have domains, zero MSP stubs created, 4/16 contacts sampled
   into the Grade queue (Eric Clary, Mark Jetton, December Johnson,
   Jay Strickland).
6. **Fixed empty-UI bug** (missing profile row; see Gotchas). User confirmed
   /runs now renders.

Research method note: the agent did the research itself with web search,
following the sourcing module's contract/rules (`web/lib/sourcing/prompts.ts`),
then ingested via run-ingest.ts. The runs are stamped with sourcing prompt v1
as provenance, though the rendered prompt text wasn't literally executed.

## IMMEDIATE NEXT STEPS

1. **User grades the two batches** in the app (/review/grade) — exercises the
   full eval gate with real data. 4 contacts pending. (User may have started.)
2. **Phase 2 — outcomes dashboard**: surface `draft_outcomes` in the app UI
   (reply rate per prompt_version × channel). There are no touches yet in dev,
   so the view is empty — build the UI so it reads sensibly at zero and fills
   in as drafting/sending happens in dev.
3. Optionally continue the pipeline on the new data: enrichment → draft →
   (mock) send to generate real touches for Phase 2/3 testing.

## Deferred / open items

- Phase 1 migration (014) is NOT applied to production; when the branch ships,
  it must be applied deliberately (we have no prod DB access — the user or the
  infra owner runs it in the prod SQL editor).
- Whoever owns the production Vercel/Supabase accounts is still unknown to us;
  merging to main auto-deploys to prod (repo: Cohesium-Capital/Cohesium-OS).
- The dev profiles backfill is a dev-DB-only manual fix; if prod ever shows the
  same symptom, same backfill applies (trigger exists in both).
- `web/scripts/verify-gate-p3.ts` and `verify-run-p2.ts` are prior verification
  scripts; `npm test` covers grading math.
- Auto-escalation (`shouldEscalate`) and `error_category` capture exist in
  schema/code but are unwired (candidate Phase 3 items).
- A PR can be opened anytime:
  https://github.com/Cohesium-Capital/Cohesium-OS/pull/new/feature/learning-loop
  — but do NOT merge to main until migration 014 has been applied to prod.
