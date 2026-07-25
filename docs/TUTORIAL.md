# Cohesium Intel — first-time user guide

## What this app does

Cohesium Intel finds companies that use managed IT providers (MSPs), figures
out who to talk to at those companies, and runs honest, personalized outreach
to them — with a human checkpoint at every stage. The left sidebar shows the
workflow as five numbered steps:
**Source → Review & Enrich → Grade → Draft → Send**. Work them left to right —
the home page's "Up next" banner always points at the stage with work waiting.

Two ideas to understand before starting:

1. **The app doesn't call any AI itself.** At the AI-powered steps (Source and
   Draft), the app generates a prompt, you run it in Claude or ChatGPT
   yourself, and paste the JSON answer back. The app validates it, stores it,
   and tracks quality. This keeps a human in the loop and the AI bill near
   zero.
2. **The eval gate.** Every sourcing run creates a *batch*, and a random
   sample of each batch is held out for you to hand-grade. A batch can't move
   forward to drafting until its graded sample clears an error threshold. This
   is how the system stops bad AI research from silently polluting your
   outreach.

## Signing in

Go to the app and enter your email. You'll get a **magic link** — no
password. Click it and you land on the **Pipeline** home page: five cards, one
per step, each showing a live count of what's waiting there. Whatever card has
a number on it is your next thing to do.

## Step 1 — Source (find companies and people)

Click **Source** in the sidebar. This is where new leads enter the system.

1. **Configure the run.** Pick one of three modes:
   - **Research MSPs** — find MSP acquisition targets themselves.
   - **Research customers** — find companies likely to use an MSP, and
     estimate which one.
   - **Find customers for specific MSPs** — pick MSPs already in your database
     (or type extra ones) and hunt for their actual customers via case
     studies, testimonials, etc.

   Set a region (e.g. "Richmond VA metro"), how many results you want, and
   optionally a target profile (e.g. "20–100 employee professional services
   firms").

2. **Click Start run.** The app creates a tracked run and copies a research
   prompt to your clipboard.

   The prompt carries a **do-not-research list**: every company already in the
   database, so the model spends its search budget on companies you don't have
   instead of rediscovering the ones you do. The page tells you how many were
   excluded. The scope follows the mode — Research MSPs excludes known MSPs,
   Research customers excludes known customers, and Find customers for specific
   MSPs excludes only the clients already recorded *for those MSPs* (the same
   company turning up under a different MSP is a genuine find, not a
   duplicate). Import-time matching still catches anything that slips through,
   so a duplicate costs research time, never data quality.

   That embedded list is capped at 400 companies, because a pasted prompt has to
   be self-contained and a longer list stops being reliably followed. Once your
   database outgrows that, run sourcing through **Claude Code** instead: it
   checks candidates against the whole database via the API, so there's no cap.
   See [docs/RUNNER.md](./RUNNER.md).

3. **Run the prompt in Claude or ChatGPT with web search turned on.** The
   model does the research and returns a JSON object.

4. **Paste the JSON back** into the box on the same page and click **Import
   results**. Optionally tick **Strict** to drop any row that has no source
   URL (rejected rows are logged, not lost).

The import report tells you how many contacts came in, how many were
**sampled for grading**, and how many were dropped. From here you can jump
straight to grading that batch or head to Review.

If you already have a list (a CSV, or something pasted from elsewhere), use
**Import CSV / paste manually** in the top corner instead.

## Step 2 — Review & Enrich (vet, then fill in emails via Clay)

Click **Review & Enrich**. This page has two jobs, labeled **A** and **B** at
the top:

**A — Vet the contacts.** A table of every sourced contact with company, title,
LinkedIn, confidence, and estimated MSP. Search by company name, or filter to
**unreviewed** rows. Give low-confidence rows a skeptical look; delete junk;
mark keepers as reviewed.

**B — Enrich via Clay.** Sourced contacts usually arrive without a work email,
and a contact can't be drafted until it has an email or LinkedIn URL. Clay
fills those in. Send the eligible set either way:

- **Push pending to Clay** — sends rows to the Clay table webhook (requires
  `CLAY_TABLE_WEBHOOK_URL`).
- **Export CSV for Clay** — downloads a CSV you import into Clay by hand.

Clay runs its waterfall (work email is the main prize; phone and LinkedIn when
it can), then writes each finished row back to the app. Statuses flip from
**pending** → **enriched** (or **failed**).

**A contact is only ever sent to Clay once.** Both paths mark what they sent,
and marked contacts drop out of the eligible set — so re-running push/export
never re-spends credits on someone Clay has already seen. Contacts held back
this way show up as *"already sent (no write-back yet)"*; if one is stuck
there, the fix is normally the write-back, not another send. **Re-send N
already sent…** exists for when a send genuinely didn't land, and asks for
confirmation because it does spend credits again. Full Clay setup lives in
[docs/CLAY.md](./CLAY.md).

You can enrich before or after Grade; Grade is what unlocks drafting for a
batch, Enrich is what gives contacts an address to write to.

## Step 3 — Grade (clear the eval gate)

Click **Grade**. This is the quality checkpoint, and it's the step people are
most tempted to skip — don't.

You'll see a keyboard-driven queue of the contacts that were randomly sampled
from your batches. For each one, the relevant fields (for sourcing: name,
title, LinkedIn) are shown with their source evidence links. Verify each field
against the sources and mark it correct or wrong; when something's wrong, type
the correction — corrections are saved and become training material for
improving the prompts later.

As you grade, each batch's gate status updates live:

- **Open** — not enough graded yet; keep going.
- **Passed** — the error rate is under the threshold; the batch may advance
  to drafting.
- **Failed** — too many errors; the batch is blocked and the run's approach
  needs rethinking.

By default the queue loads every ungraded sample across all batches so you can
clear the backlog in one sitting (use the per-batch **Grade** buttons on
**Runs** to grade a single batch in isolation). The thresholds and sampling
rate are configurable in **Settings**.

## Step 4 — Draft (write the outreach)

Click **Draft**. Only contacts whose batch **passed** the gate, and who have
at least an email or a LinkedIn URL, appear here.

Same copy-paste rhythm as Source:

1. Choose a mode: **single** (one focused batch of ~20 contacts pasted into a
   chat — best quality per message) or **agent** (hand the whole list to
   Claude Code, which fans it out to subagents — faster for big lists; tune
   the batch size down if quality slips).
2. **Copy the prompt**, run it in Claude/ChatGPT with web search on (single
   mode) or Claude Code (agent mode).
3. **Paste the JSON drafts back** and import.

Each imported draft becomes a *planned touch*, stamped with the prompt version
that produced it — that provenance is what powers the Outcomes page later.

## Step 5 — Send (approve and ship)

Click **Send** (the draft queue). Every planned message is listed with its
subject and body.

- Read the drafts. **Edit anything that's off** — edits are logged as a
  quality signal against the prompt.
- Uncheck anything that shouldn't go; unchecked rows are marked "needs
  re-draft".
- Select rows and **Send back to drafting** to regenerate them — those
  contacts reappear on the Draft page, nothing is deleted.
- Click **Send approved →** when ready. Email drips out from cohesium.co on a
  schedule; LinkedIn messages push to HeyReach. Anyone who already replied is
  automatically skipped. This can't be undone, so read twice.

## The Data section (keeping score)

- **Runs** — every batch ever produced: totals, sample size, grading
  progress, error counts, and gate status. This is your control panel for
  what needs grading and what's cleared.
- **Outcomes** — the learning-loop scoreboard: per prompt version and
  channel, how many messages were drafted, sent, replied, bounced, and edited
  before sending, with reply rates. Empty until you've drafted and sent; it
  fills in on its own and tells you whether a prompt revision actually made
  things better.
- **MSPs** — the acquisition-target list with per-MSP customer counts.

## Settings

Manage **prompt versions** (each Source/Draft prompt is versioned; the active
version is what runs use) and the **eval gate parameters** (sampling rate,
minimum sample size, error-rate threshold).

## Your first session, condensed

1. Sign in via magic link.
2. Source: pick a mode and region → Start run → run prompt in Claude → paste
   JSON → Import.
3. Review & Enrich: vet the contacts (A), then push pending rows to Clay for
   work emails (B).
4. Grade the sampled contacts until the batch passes.
5. Draft: copy prompt → run → paste JSON.
6. Send: read every message, edit or reject, then Send approved.
7. Check Runs and Outcomes to see how the batch — and the prompts —
   performed.
