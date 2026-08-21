---
name: source-advisors
description: Find the investment advisors and brokers of record attached to a TPA's plans, classify them, and ingest them into Cohesium as referral partners. Use when asked to source advisors for a TPA, build the referral channel, find who advises a target's plans, or top up the advisor pipeline for Ilium Holdings.
---

# Advisor sourcing runner (Ilium Holdings)

You are the `runner` executor for an **advisor** sourcing run. The goal is not
acquisition targets and not their plan sponsors. It is the third population: the
investment advisors and brokers of record who sit on the plans our target TPAs
administer, and who can refer a TPA owner to us.

Why they are worth reaching: an advisor is close to owners who may want liquidity
or a succession path, and when Ilium acquires a firm, that owner walks away
liquid and looking for advice. The conversation runs both directions. That is a
business-development approach, not research — do not frame it as one.

This skill covers the advisor mode specifically. For target companies and plan
sponsors, use the general `source-companies` skill instead.

## Setup

Same two values as the general runner:

| Variable | Meaning |
|---|---|
| `COHESIUM_API_URL` | Base URL of the app |
| `COHESIUM_API_TOKEN` | Token from the app: **Settings → API tokens → Create token** |

```bash
set -a; [ -f .env ] && . ./.env; set +a
: "${COHESIUM_API_URL:?set COHESIUM_API_URL (env or .env)}"
: "${COHESIUM_API_TOKEN:?set COHESIUM_API_TOKEN (env or .env)}"
```

Never echo the token. If either value is missing, stop and ask for it rather
than improvising another route into the database.

You also need the Form 5500 working set and:

- `scripts/advisor_tpa_join.py` — the working join
- `references/classify-advisor-firm-type.md` — the classification contract

## The headline rule: there are TWO joins and you need both

Form 5500 reaches an advisor from a plan **two independent ways**, and they
overlap on **under 10% of firms**:

| Route | What it names | Population |
|---|---|---|
| **Within Schedule C** | Both the administrator and the plan's investment advisor | ~30,400 plans — the fee-based population |
| **Schedule C → Schedule A** | `INS_BROKER_NAME`, the insurance broker of record | ~10,800 plans — all insurance-funded |

**Running only one silently halves the universe**, and nothing in the output
tells you it happened. Enumerate both, run both, then merge and dedupe by firm.
This is the mistake that has already cost a full run here — it is first in this
document because it is first in the order things go wrong.

Plan counts must be deduped **across** the routes before they are reported. A
plan that appears in both is one shared plan, not two.

## Four traps, each of which has cost a run

### 1. TPAs appear as their own broker of record, often

A TPA that names itself in the affiliation field is not an advisor — it is the
same company on both sides. Orenda appears as broker of record on 122 of its own
plans.

Detect it properly: build the set of **every firm that files as an administrator
anywhere** (roughly 4,200 of them), then flag any candidate whose name matches
that set. On the last run this reclassified **322 of 996 rows** — a large
minority, not a handful. If your flag count is in the single digits, your
matching is broken.

The app enforces this independently: any advisor whose name or domain resolves to
a TPA already held in the workspace is held out of the import and logged to
`rejected_ingest`. That is a backstop, not a substitute — it only catches firms
already in the pipeline.

### 2. Not every Schedule C "advisor" is one

Empower Advisory Group, Wilshire and Morningstar all file as `INVESTMENT
ADVISOR`. None of them refers plans. They are recordkeepers, index providers and
research houses sitting in the same field as a two-person local practice.

**No pattern match separates these.** An agent has to read the firm's website and
its Form ADV and decide. Follow `references/classify-advisor-firm-type.md` and put
the verdict in `advisor_firm_type`. Drop the firms that plainly cannot refer
business rather than importing them for someone else to sort out.

### 3. The filed address is often not the advisor's

Filings frequently carry a carrier's or parent's corporate address, which
clusters dozens of unrelated firms into one city. The VALIC Houston 77019 cluster
is the worst case in this data.

Never take `hq_city` / `hq_state` from the filing. Take them from the firm's own
site, or leave them null. Null is correct and costs nothing; a carrier's address
is wrong and looks right.

### 4. Name matching must not treat industry words as noise

Dropping the words that name the industry leaves two different companies looking
identical. "National Benefit Services" and "National Retirement Services" match
at a perfect score under that rule and are not the same firm.

Require the distinguishing word to match, and confirm with a domain or a real
address before asserting two names are one firm.

## The loop

### 0. Resolve TPAs to ids

`find_advisors_for_msps` takes `mspIds`, and those are **UUIDs**.

```bash
curl -sS "$COHESIUM_API_URL/api/sourcing/targets" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN"
```

Match the operator's wording against `name` yourself. When a name is ambiguous,
**ask** rather than starting a run against a TPA they did not mean.

### 1. Start the run

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/runs" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"find_advisors_for_msps","mspIds":["<uuid>"],"countPer":25}'
```

**Pass exactly one id in `mspIds`, and loop for more than one.** A single target
is what lets the run record yield, and what scopes the already-known check to
that TPA's advisors.

The response carries `runId`, `batchId`, `prompt`, and `checkKnown`
(`{kind: "advisor", mspId}`). Read `prompt` and follow it — it is the versioned
brief the run's quality is attributed to.

### 2. Run both joins

Use `scripts/advisor_tpa_join.py`. Produce, per candidate firm, the set of TPAs
from step 0 it is on record with, and for each of those edges:

- which route produced it (`schedule_c`, `schedule_a`, or `both`)
- the **distinct** shared plan count, deduped across routes
- the filed relation string, verbatim

### 3. Apply the four traps above

In order. Flag and remove the self-brokers, classify the survivors, discard the
filed addresses, and tighten the name matching. This is where the run's value is
actually created — the join is mechanical, this part is not.

### 4. Ask which are new

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/known" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"advisor","candidates":[{"name":"Keel Point Advisory","domain":"keelpoint.example"}]}'
```

Pass `kind` straight from the run's `checkKnown` — it is `"advisor"` here, not
`"customer"`. The comparison runs against every organization we hold, with no
cap.

An advisor we already hold is only "known" for the **TPAs it already reaches**.
Finding the same firm against a different TPA is a new edge and worth returning.

### 5. Find a contact at each firm

**Aim at the principals.** The persona keys are schema literals, not job
descriptions — on this track read them as seniority inside the practice:

- `owner` — a principal or partner of the practice. This is the main audience.
- `head_of_it` — an advisor at the firm who is not a principal, or whoever runs
  the plan relationships day to day. The key is a legacy artifact of the schema;
  it does not mean anyone technical here.
- `other` — anyone else worth writing to.

A firm with no named person is not usable, so put the search effort into finding
one, with a LinkedIn URL where you can.

### 6. Ingest

```bash
curl -sS -X POST "$COHESIUM_API_URL/api/sourcing/runs/<runId>/ingest" \
  -H "Authorization: Bearer $COHESIUM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

The shape:

```jsonc
{
  "organizations": [
    {
      "name": "Keel Point Advisory",
      "domain": "keelpoint.example",
      "hq_city": null,                  // the firm's OWN office, or null — never the filing's
      "hq_state": null,
      "advisor_firm_type": "fee_based_practice",   // your classification verdict
      "source_url": "https://…",        // required: evidence-gated ingest
      "confidence": "high",
      "tpa_links": [
        {
          "tpa_name": "Nova 401(k) Associates",   // EXACT name from step 0
          "join_source": "both",
          "shared_plan_count": 14,
          "relation": "INVESTMENT ADVISOR",
          "source_url": "https://…"
        }
      ],
      "contacts": [
        {
          "full_name": "Dana Whitfield",
          "persona": "owner",
          "title": "Managing Principal",
          "linkedin_url": "https://www.linkedin.com/in/…",
          "source_url": "https://…",
          "confidence": "high"
        }
      ]
    }
  ]
}
```

Evidence is required by default: an organization with no `source_url` is rejected
and logged rather than imported.

**What the app does with `tpa_links`:**

- A named TPA that this workspace does not hold is **skipped and reported** — no
  stub is created. Unlike the customer path, an advisor naming an unknown
  administrator does not tell us to go acquire it. If the TPA belongs in the
  pipeline, source it as a target first, then re-run.
- Re-running refreshes an existing edge in place rather than duplicating it.
- Edges arriving on two rows of the same firm merge: two different routes become
  `both`, and plan counts take the **maximum**, never the sum.
- An advisor row with no links is imported but flagged for review — there is no
  referral basis to draft from.

A `200` means the rows landed; **`422` means nothing was imported** — read
`error` and `messages`, fix, and retry. A run can only ingest once.

## Coverage: a thin result is a normal result

Most TPAs have a small number of genuinely referable firms around them. Returning
fewer well-evidenced rows is the job. Do not pad the list to make it look
complete, and do not treat a small number as evidence you did it wrong — check
instead that you ran **both** joins, because that is the failure that actually
produces a thin result.

## Report back

In numbers:

- plans matched per route, and how many firms came from each
- how many firms appeared in **both** routes
- how many were flagged as TPAs filing as their own broker
- how many survived classification, and how many you dropped and why
- how many were already known
- how many you imported, and how many edges were written
- any TPA names that could not be resolved
- the `batchId`, so the operator can grade it

## Rules

- **Never run one join.** It is the top of this document for a reason.
- **Never classify by pattern match.** Read the site and the ADV.
- **Never take an address from a filing.**
- **Never reach for the database directly** or ask for a service-role key. The
  token path applies row-level security.
- **Do not invent data to hit a count.** A fabricated firm poisons the dataset
  this whole system exists to build, and an advisor row is worse than most: it
  puts a real person's name on outreach that proposes a business relationship.
