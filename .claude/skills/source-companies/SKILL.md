---
name: source-companies
description: Run a sourcing run end-to-end against the Cohesium API — start a run, shortlist candidates, check them against existing records so nothing is researched twice, research only what is new, and ingest the results. Use when asked to source companies or contacts, find the customers of a named provider, or top up the sourcing pipeline.
---

# Sourcing runner

You are the `runner` executor for a sourcing run. The operator alternative is
copy-pasting a prompt into a chat window; you do the same work through the API,
with one capability a pasted prompt does not have: **you can ask which companies
we already hold, against the entire database, as many times as you like.**

That capability is the whole point of this path. A pasted prompt has to carry
its exclusion list inline, so it is capped at 400 names — past that the list
both overflows the prompt and stops being reliably followed. You have no cap.
Use it.

## Setup

Two values:

| Variable | Meaning |
|---|---|
| `COHESIUM_API_URL` | Base URL of the app, e.g. `https://your-app.example.com` (or `http://localhost:3000`) |
| `COHESIUM_API_TOKEN` | Token from the app: **Settings → API tokens → Create token** |

Load them at the start of every session, before the first request. An exported
shell variable only exists in the terminal that exported it, so a session
started from the desktop app or an IDE will not see one — fall back to a `.env`
file in the working directory:

```bash
set -a; [ -f .env ] && . ./.env; set +a
: "${COHESIUM_API_URL:?set COHESIUM_API_URL (env or .env)}"
: "${COHESIUM_API_TOKEN:?set COHESIUM_API_TOKEN (env or .env)}"
```

Run that once per session, then reuse the variables. Every request sends
`Authorization: Bearer $COHESIUM_API_TOKEN`.

Never echo the token, and never paste it into a file that is not gitignored.

If either value is missing, stop and tell the operator to add them to `.env` or
export them. Do not improvise another route into the database — the token is
deliberately scoped to one user's row-level permissions, and there is no
supported path around it.

### If the first request cannot connect

A Claude Code session running inside the Claude app is sandboxed, and its
default network setting blocks outbound requests beyond a small allowlist. This
skill is nothing but outbound requests to the app, so it cannot work there until
that is changed.

The symptom is a connection refused, DNS, or timeout error on the first call —
**not** a 401 or 403, because the request never leaves the sandbox. If you see
that, stop and tell the operator:

> This session can't reach the app. In the Claude app, set this session's
> network access to **full**, then ask me again.

Do not work around it: not by switching to a different host, not by asking for
database credentials, and not by researching companies without the
already-known check. A sandbox that blocks the API also blocks the deduplication
that makes this path worth using.

## The loop

### 1. Start the run

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/runs" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"research_customers","region":"Richmond VA metro","count":25,
       "profile":"20-100 employee professional services firms"}'
```

`mode` is one of:

- `research_msps` — find MSPs themselves
- `research_customers` — find companies that use an MSP
- `find_customers_for_msps` — find the clients of specific MSPs (requires
  `mspIds: [...]`)

The response carries `runId`, `batchId`, `prompt`, and `checkKnown`
(`{kind, mspId}`). **Read `prompt` and follow it** — it is the versioned
research brief, and it is what the run's quality is later attributed to. Do not
substitute your own idea of the task.

### 2. Shortlist cheaply

Generate a wide list of candidate company names that fit the brief — roughly
**3× the requested count**, because many will already be known. Names and (where
you already know them) domains only.

Do not verify these yet. No site visits, no contact hunting, no evidence
gathering. That work is the expensive part and most of these candidates will be
discarded in the next step.

### 3. Ask which are new

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/known" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"customer","candidates":[{"name":"Acme Dental","domain":"acmedental.com"},
       {"name":"Barton Legal"}]}'
```

Pass `kind` and `mspId` straight from the run's `checkKnown`. Up to 2000
candidates per request; chunk if you have more. The comparison runs against
**every** organization we hold, with no cap or truncation, so its answer is
authoritative — never second-guess it or skip the call to save a round trip.

The response gives you `new` (research these) and `known` (already held; each
carries `matched` so you can see what it collided with).

### 4. Research only the new ones

Take from `new` up to the requested count and do the real work per company:
verify it exists, establish the MSP relationship, find an owner or IT-lead
contact, and collect a **source URL for every row**. Follow the rules in the
run's `prompt` exactly — especially: never invent a company, person, domain, or
MSP relationship. An honest omission beats a confident guess, because a
fabricated row poisons the dataset this whole system exists to build.

If `new` runs out before you reach the requested count, **go back to step 2 with
a different angle** — another city, industry, or source type. Do not pad the
results with companies you could not verify, and do not fall back to researching
something from `known`.

### 5. Ingest

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/runs/<runId>/ingest" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"organizations":[ ... ]}'
```

The body is the exact JSON shape the run's `prompt` specifies. Evidence is
required by default: any organization without a `source_url` is rejected and
logged rather than imported. That is intentional — pass
`"requireEvidence": false` only if the operator explicitly asks for it.

A `200` means the rows landed; **`422` means nothing was imported** — read
`error` and `messages`, fix, and retry. A run can only ingest once, so if it
reports "already ingested", start a new run rather than trying again.

## Report back

Tell the operator, in numbers:

- how many candidates you shortlisted
- how many were already known (this is the research you *avoided*)
- how many you researched and imported
- how many were rejected for missing evidence
- the `batchId`, so they can grade it

## Rules

- **Never skip step 3.** Researching a company we already hold is the exact
  waste this path exists to eliminate.
- **Never reach for the database directly** or ask for a service-role key. The
  token path applies row-level security; a service key bypasses it entirely,
  which is unacceptable now and becomes a cross-tenant leak later.
- **Do not invent data to hit the count.** Returning 12 verified companies is a
  good outcome; returning 25 with 13 guesses is a bad one that is expensive to
  undo.
- **One run, one ingest.** Don't retry an ingest that already succeeded.
- **A connection error is a setup problem, not a reason to improvise.** In the
  Claude app that almost always means network access is not set to full — say
  so and stop, rather than finding another way to produce rows.
