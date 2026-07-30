# Onboarding a new tenant's first admin

Written for Saagar Kulkarni (Ilium Holdings, July 2026), and kept as the
template for whoever is next. A shareable version of this went out as a hosted
page — this is the copy that gets updated when the system changes.

`TUTORIAL.md` explains how to *use* the pipeline. This is what has to be true
before that guide is any use: an account, a mailbox, and knowing which stages
stop for a human.

## The shape of it

Three things gate a new tenant, in this order:

1. **Sign in** — the invite is keyed on an email address.
2. **Connect a mailbox** — the only hard blocker. Nothing sends without it.
3. **Optionally, the runner** — Claude Code instead of copy-paste.

Everything else the workspace needs (market vocabulary, worked examples, gate
thresholds) is seeded by migration before the person ever logs in.

## 1. Sign in

<https://cohesium-os.vercel.app>, enter the email, click the magic link. No
password.

**The address must match the invite exactly.** Any other address signs in fine
and lands on an empty account, which reads as a broken app rather than a wrong
login — this is the single most likely first-five-minutes failure, so say it up
front.

First sign-in claims the invite (`claim_workspace_invites()`, which runs on
every Settings load) and the role it carries. Ilium's invite is `admin`.

## 2. Connect a mailbox

The tool sends as the person, from their own mailbox. **A tenant other than the
operator workspace cannot fall back to the environment credentials** — that gate
is deliberate (`identity.ts`: `envAllowed = envWorkspaceId !== null &&
workspaceId === envWorkspaceId`), so a new tenant with no identity has its
approved messages sit `queued` rather than sending from someone else's account.

### Google Workspace

| Field | Value |
|---|---|
| SMTP host / port | `smtp.gmail.com` · 465 |
| IMAP host / port | `imap.gmail.com` · 993 |
| Username (both) | the full address |
| Password (both) | a 16-character **app password**, not the account password |

Prerequisites, in order:

1. **2-Step Verification on** — Google issues no app password without it.
2. **App password created** at <https://myaccount.google.com/apppasswords>.
   A Workspace admin can disable app passwords org-wide; if the page is
   missing, that is why, and there is no route around it — the code speaks no
   OAuth.
3. **IMAP enabled** — Admin console → Apps → Google Workspace → Gmail → End
   user access → IMAP access. Usually on, disable-able per group.

### Both halves, or nothing sends

Capture-before-send is enforced per inbox: the cron reads the mailbox for
replies and opt-outs before it will send from it, so an identity with SMTP and
no IMAP is a mailbox that never sends, and the reason is easy to miss. See the
tenancy runbook for the mechanism.

### Two Gmail-specific notes

- **Duplicate copies in Sent.** Gmail files anything sent through its SMTP, and
  `sendMail` also appends to the Sent folder itself (`smtp.ts` → `appendToSent`).
  Harmless, invisible to recipients, no toggle today.
- **Sending domain.** Outreach from the firm's primary domain puts its main mail
  reputation behind the campaign. A separate sending domain with its own SPF,
  DKIM and DMARC is the usual practice, and it is far cheaper to decide before
  the first send than after.

### What the app will not let them do

Read a saved credential back. `sending_secret` has RLS enabled with no policy
for `authenticated` at all, so Postgres denies every browser session including
an admin's; writes go through `set_sending_secret()`, which treats a null as
"leave that one alone" so re-saving a form with a blank password does not wipe
it. The cron reads secrets as `service_role`.

## 3. LinkedIn, if they will use it

Email and LinkedIn are separate setups, and LinkedIn is the one people assume is
included. It runs through **HeyReach**, and there are two routes:

- **They bring their own HeyReach account**, and connect their LinkedIn profile
  to it, or
- **You add them as a seat on yours**, and they connect their LinkedIn profile
  there.

Either way the LinkedIn profile is theirs and they connect it themselves —
HeyReach sends from a real account, so there is no version of this where someone
else's messages go out under their name. Until it is connected, LinkedIn touches
draft normally and simply never send.

## 4. The runner (optional)

1. **Settings → API tokens → Create.** Shown once. Pinned to the workspace it
   was minted in, so it can only ever write there.
2. **`.env` in the folder Claude Code opens** — an `export` is invisible to a
   session started from the desktop app, which is why the skill reads a file.

   ```
   COHESIUM_API_URL=https://cohesium-os.vercel.app
   COHESIUM_API_TOKEN=cin_…
   ```
3. **Settings → Runner setup → download `SKILL.md`** to
   `~/.claude/skills/source-companies/SKILL.md`. Take the download, not the
   public repo: the download is rendered in the tenant's own vocabulary, the
   public copy is deliberately market-neutral.
4. **Claude desktop app: network access → full.** Sandboxed sessions block
   outbound requests; the symptom is a connection error on the first call, with
   nothing in the app's logs because the request never left.

Personalize and Draft also offer **Fan out (Claude Code)**, which chunks the
work across subagents and POSTs the result back to `/api/runs/<id>/ingest` — no
JSON changes hands. See `RUNNER.md` for the API and its scopes.

## 5. What to tell them about the gates

Three stages do not advance without a human, and a new user reads all three as
the app being stuck unless told otherwise:

- **Review** — vetting the sourced rows.
- **Grade** — a sample of every batch is graded by hand; too many errors and the
  batch cannot proceed. This is the eval gate, and it is the reason runner
  output is trustworthy.
- **Send** — every message read and approved individually.

"No verifiable hook found" is a **completed** contact at the Personalize stage,
not a failure. Worth saying explicitly: it is what stops the model inventing a
flattering detail, and it looks like an error to anyone who has not been told.

## 6. Check what is already in the workspace

Whoever prepared the tenant has usually run a batch or two. Worth looking before
handing over — but read the output, don't infer it from the prompt's history.

Ilium's handover: 38 companies, 20 contacts, 19 hooks and 34 drafts existed at
sign-up, all written before migration 047 fixed the market vocabulary. The
drafts were fine anyway. The prompt's framing sentence said "IT", but the hooks,
persona angles and worked examples were all retirement-specific, and the model
followed those — **zero** drafts contained "IT", "managed IT", "IT provider" or
"MSP". A stale prompt is a reason to check the output, not to assume it is
wrong.

```sql
-- Case SENSITIVE on purpose: `~*` also matches the ordinary word "it", which
-- appears in most sentences ever written. Getting this wrong once produced a
-- confident report that 23 of 34 drafts were contaminated. None were.
select count(*) filter (where t.body ~ '\mIT\M')                       as it_the_industry,
       count(*) filter (where t.body ~* 'managed IT|IT provider|\mMSP') as msp_phrases,
       count(*)                                                          as total
  from public.touches t
 where t.workspace_id = (select id from public.workspaces where name = '<tenant>');
```

## Known gaps to mention up front

- `approachInline` and `approachBullet` change only by migration — they are
  wrapped renderings of `approach`, and their line breaks are part of the prompt
  hash. Everything else in a workspace's prose (worked examples, persona angles,
  perspectives, subject-line shapes) and its whole vocabulary is editable in
  Settings.
- No billing or usage view anywhere.
