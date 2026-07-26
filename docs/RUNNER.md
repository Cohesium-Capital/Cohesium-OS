# The sourcing runner — Claude Code as an executor

A sourcing run can be executed two ways. Both produce the same rows, the same
batch, the same grading sample, and the same prompt-version attribution.

| | `copy_paste` | `runner` |
|---|---|---|
| Who drives it | you, pasting into Claude/ChatGPT | a Claude Code session |
| How it avoids re-research | exclusion list embedded in the prompt | asks the API, per candidate batch |
| Cap on that | **400 companies** | **none** |

## Why the copy-paste path has a cap at all

A pasted prompt is a one-shot artifact: it cannot ask a follow-up question, so
everything it needs must be inside it. The do-not-research list therefore grows
with your database, and two limits arrive — the window, and well before that,
the point where a model stops reliably tracking a long list of names while also
following the rules underneath it. 400 is a judgement about the second limit,
not the first. Raising it would trade one failure mode for a quieter one.

The runner doesn't have that problem, because it can ask.

## How the runner removes the cap

The trick is inverting the list. Instead of "here are the thousands of companies
to avoid", the expensive prompt ends up carrying "here are the 25 companies to
research" — an **inclusion** list bounded by what you asked for rather than by
how much you already have.

```
1. shortlist    ~3x the requested count, names only — cheap, no verification
2. check        POST /api/sourcing/known  →  compares against EVERY org held
3. research     only what came back as new, up to the requested count
4. ingest       POST /api/sourcing/runs/<id>/ingest  →  the normal ingest path
```

Step 2 is a SQL-side comparison over the whole table, so it has no cap and no
truncation. Step 3 — the part that actually costs search budget and wall time —
only ever touches companies you don't have.

Steps 2 and 4 share their matching and ingest logic with the copy-paste path
(`lib/sourcing/known.ts`, `ingestRun`). The filter cannot drift from the ingest
dedupe, because they are the same code.

## Security: why a token and not the service key

The runner runs on a laptop. The obvious shortcut — hand it
`SUPABASE_SERVICE_ROLE_KEY` — is the one thing that must not happen: that key
**bypasses RLS entirely**. Today that means an agent session can read every row
in the database; once tenancy lands it means every tenant's rows.

Instead:

1. You create a token in the app (**Settings → API tokens**). Only its SHA-256
   hash is stored; the raw value is shown once.
2. The runner sends it as `Authorization: Bearer <token>`.
3. The API resolves it to **one owning user** and mints a **5-minute** Supabase
   user JWT for them (`lib/auth/user-jwt.ts`).
4. Every query then runs under that user's row-level policies — identical to
   what their browser session can see, and nothing more.

Consequences worth knowing:

- A runner request is never more privileged than the person whose token it is.
- `api_tokens` is owner-only by policy, not `members full access` — one member
  cannot read or mint a credential that acts as another. (Admins included: an
  admin who wants runner access makes their own token.)
- `SUPABASE_JWT_SECRET` unset ⇒ the runner API returns **500 and refuses the
  request**. It never falls back to the service role.
- `runs.api_token_id` records which token drove each run, so a compromised
  token's output can be found and rolled back.
- Revoking is immediate and keeps the row, preserving that trace.

> **Check before deploying:** this mints HS256 JWTs against the project's shared
> JWT secret. If your Supabase project has moved to asymmetric-only JWT signing
> keys, the legacy secret won't validate and this needs to sign with the
> project's current key instead. Verify in Project Settings → API → JWT Settings
> that a JWT Secret is present.

## Setup

1. **Settings → API tokens → Create token.** Copy it immediately.
2. Set `SUPABASE_JWT_SECRET` in the app's environment (see `.env.example`).
3. In the runner's shell:

```bash
export COHESIUM_API_URL=https://your-app.vercel.app
export COHESIUM_API_TOKEN=cin_…
```

4. Ask Claude Code to source — the `source-companies` skill
   (`.claude/skills/source-companies/SKILL.md`) carries the loop.

## API

All routes require `Authorization: Bearer <token>` with the `sourcing` scope.

### `POST /api/sourcing/runs`

Starts a run and returns the research brief.

```jsonc
// request
{ "mode": "research_customers",     // | research_msps | find_customers_for_msps
  "region": "Richmond VA metro",
  "profile": "20-100 employee professional services firms",
  "count": 25,
  "mspIds": [] }                     // required for find_customers_for_msps

// response
{ "runId": "…", "batchId": "…", "promptVersionId": "…",
  "prompt": "…",                     // follow this; it is the versioned brief
  "notes": ["Runner run: candidates are checked …"],
  "checkKnown": { "kind": "customer", "mspId": null } }
```

### `POST /api/sourcing/known`

The uncapped check. Up to 2000 candidates per request; call as often as needed.

```jsonc
// request
{ "kind": "customer",
  "candidates": [ { "name": "Acme Dental", "domain": "acmedental.com" },
                  { "name": "Barton Legal" } ],
  "mspId": null }

// response
{ "new":   [ { "name": "Barton Legal", "domain": null, "known": false } ],
  "known": [ { "name": "Acme Dental", "known": true,
               "matched": "Acme Dental Group", "matchedOn": "domain" } ],
  "counts": { "submitted": 2, "considered": 2, "known": 1, "new": 1,
              "comparedAgainst": 4312 } }
```

`mspId` scopes the question to one MSP's client list. Pass it for
`find_customers_for_msps` and leave it null otherwise — the difference matters:

- **scoped**: known only if we already record it as *that MSP's* client, because
  the same company under a different MSP is genuine new information.
- **unscoped**: known if we hold the company at all, regardless of MSP — for
  plain research there's no reason to spend a search on a company we have.

### `POST /api/sourcing/runs/<runId>/ingest`

The same `ingestRun` the copy-paste flow uses: same contract validation, same
evidence gate, same batch tagging, same grading sample. Evidence is required by
default on this path.

`200` = rows landed. **`422` = nothing was imported** — read `error` and
`messages`. A run ingests once; if it reports "already ingested", start a new
run.

## What the runner does not change

- Rows still land in a batch and are still sampled for grading. Runner output is
  not trusted more than pasted output.
- The prompt is still versioned and still attributed — `runs.prompt_version_id`
  and `rendered_prompt` are populated exactly as before.
- Ingest still rejects evidence-less organizations to `rejected_ingest`.
