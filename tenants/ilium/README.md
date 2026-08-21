# Ilium Holdings — tenant-specific runner material

Everything under `tenants/` is **market-specific by nature** and deliberately not
part of the shared, market-neutral surface in `.claude/skills/` or `web/lib/`.

## Why this directory exists

The app's own runner skill (`.claude/skills/source-companies/SKILL.md`) is
rendered per tenant from `workspace_profile.vocab`, so an Ilium collaborator
downloading it from **Settings → Runner setup** already gets a copy that says
"TPAs" and "investment advisors" rather than "MSPs". That mechanism handles
vocabulary.

It cannot handle **method**. The advisor layer is reached through Form 5500 —
Schedule C, Schedule A, `INS_BROKER_NAME`, Form ADV — and none of that
generalizes to a tenant researching a different market. Writing it into the
shared skill would give every future tenant instructions about retirement plan
filings, which is exactly what the vocabulary work exists to prevent.

So it lives here, scoped to the tenant it is true for.

## What to share

`skills/source-advisors/SKILL.md` — the advisor sourcing runner. Hand it to
anyone working the Ilium referral channel; they install it at:

```
~/.claude/skills/source-advisors/SKILL.md
```

It is self-contained: setup, both Form 5500 joins, the four traps, the API loop,
and the ingest payload shape. It expects two files alongside it in the working
repo:

- `scripts/advisor_tpa_join.py` — the working join
- `references/classify-advisor-firm-type.md` — the classification contract

## What NOT to do with it

- **Do not** merge it into `.claude/skills/source-companies/SKILL.md`. That file
  is byte-compared against `web/lib/runner/skill.json` by `skill.test.ts`, is
  published to the public runner repo, and is rendered for every tenant.
- **Do not** add Form 5500 vocabulary to `web/lib/sourcing/prompts.ts`. The
  `find_advisors_for_msps` prompt there states the two-route rule and the four
  traps in market-neutral terms on purpose; this document supplies the specifics.

## Keeping the two in step

The API contract (mode keys, `mspIds`, the `tpa_links` shape, `kind: "advisor"`
on the known-check) is shared. If it changes in `web/lib/contracts.ts` or
`web/app/api/sourcing/`, update this skill in the same commit — nothing tests
that they agree.
