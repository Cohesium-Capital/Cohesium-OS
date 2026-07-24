// The demo walkthrough script. Each step names the stage's GOAL and WHERE the
// judgment it asks for is stored, because that is the whole pitch: this system
// runs honest outreach and must produce learning — judgments land in tables,
// not in anyone's head.
//
// Contract: `target` is a data-tour attribute name on the destination page
// (null = centered card, no spotlight). `kind: "try"` steps have the user
// perform the real judgment on demo rows; the overlay lets clicks/keys pass
// through inside the spotlight cutout so the underlying UI actually works.
// The final `kind: "finish"` step swaps Next for a cleanup button that calls
// wipeDemoTour().

export const TOUR_STORAGE_KEY = "cohesium-tour";

export type TourStepKind = "info" | "try" | "finish";

export type TourStep = {
  route: string;
  /** data-tour anchor on the destination page; null renders a centered card. */
  target: string | null;
  title: string;
  body: string;
  kind: TourStepKind;
};

export const TOUR_STEPS: TourStep[] = [
  {
    route: "/",
    target: "hero",
    title: "This system must produce learning",
    body:
      "Cohesium runs honest outreach: every batch passes a gate before it costs money or sends mail, and every judgment you make — a grade, a hook verdict, an edit, a triage call — is stored where the next run can learn from it. This card always names your single highest-leverage action, so the pipeline never lives in your head. You're about to walk the real UI on clearly-fake demo rows and make the actual judgments yourself.",
    kind: "info",
  },
  {
    route: "/",
    target: "tiles",
    title: "Seven stages, one direction",
    body:
      "Work flows Source → Review & Enrich → Grade → Personalize → Draft → Send → Triage. Each tile shows what's waiting at that stage plus its gate reading. The chips are honest: a dash means no data yet — a stage never shows a green it hasn't earned, because a metric chip is a promise the loop behind it is live.",
    kind: "info",
  },
  {
    route: "/",
    target: "health",
    title: "The numbers that should stay at zero",
    body:
      "Failed sends, bounces, pending suppressions, untriaged replies, failed batches — plus the daily send cap. These are the failure modes that compound quietly if nobody watches. Anything non-zero tints red and links straight to the surface where you fix it.",
    kind: "info",
  },
  {
    route: "/source",
    target: "source-modes",
    title: "Source: find MSP users, with evidence",
    body:
      "Source's goal is companies that verifiably use an MSP. Three research modes drive a copy-paste LLM loop: the app renders the prompt, you run it in your LLM of choice, and paste the results back. Every claim must carry evidence — rows without it don't survive review. Your demo batch is already here, imported as if you'd just pasted a run.",
    kind: "info",
  },
  {
    route: "/source",
    target: "source-run",
    title: "Attribution is mechanical",
    body:
      "Every run stamps the exact rendered prompt and its hash onto the batch it produced. Nothing is remembered, everything is recorded: when a batch fails its gate next week, you can pull up precisely the prompt that made it — and fix the prompt, not the symptom.",
    kind: "info",
  },
  {
    route: "/review",
    target: "review-grid",
    title: "Review: the fit judgment",
    body:
      "Vetting asks one question: is this org worth pursuing? That judgment is deliberately kept OUT of gate math — the gate measures whether sourcing was accurate, not whether you liked the company. Removing a row is a soft-delete with a reason, so even a 'no' is stored learning rather than a silent disappearance.",
    kind: "info",
  },
  {
    route: "/review",
    target: "review-clay",
    title: "The gate gates spend",
    body:
      "Enrichment costs real money, so only reviewed contacts from batches that passed their gate can be pushed to Clay for work emails — and the push is scoped to exactly the rows you select. Your demo rows are deliberately ineligible: they stay unreviewed so this walkthrough can never trigger a real Clay push.",
    kind: "info",
  },
  {
    route: "/review/grade",
    target: "grade-gate",
    title: "The eval gate",
    body:
      "Each batch gets a deterministic sample pulled for human grading, and the batch passes only if the error rate stays under threshold. Fail fast, before spend and before sends. These numbers update live as you grade — you're about to move them.",
    kind: "info",
  },
  {
    route: "/review/grade",
    target: "grade-card",
    title: "Try it: grade the 6 demo contacts",
    body:
      "Press A to approve each accurate record. One contact has the wrong title — press C, fix the title, and pick an error category. Corrections don't just fix the row: they become the eval set that future sourcing prompts are scored against. With 1 error in 6 (16.7%, under the 20% threshold), watch the gate flip to passed.",
    kind: "try",
  },
  {
    route: "/personalize",
    target: "personalize-builder",
    title: "Personalize: one verifiable claim",
    body:
      "Before any drafting, each contact gets at most one hook: a verifiable claim with a source. An honest 'none found' is a first-class outcome — a contact with no hook drafts from the control arm instead of receiving an invented compliment. The stage's product is claims you can defend, not flattery.",
    kind: "info",
  },
  {
    route: "/personalize",
    target: "verify-card",
    title: "Try it: verify the 5 demo hooks",
    body:
      "Press V when the cited source actually supports the claim. One hook is generic — 'they have a website' — give it G. Generic personalization is worse than none: it spends credibility and teaches the loop nothing. Your verdicts land on the hooks themselves, and at 1 rejection in 5 (20%, under the 25% threshold) the batch passes.",
    kind: "try",
  },
  {
    route: "/draft",
    target: "draft-coverage",
    title: "Drafting is pure writing now",
    body:
      "Hooks are settled before drafting starts, so holding them constant de-confounds prompt A/B tests — when prompt v3 beats v2, it's the prompt, not luckier research. Hookless contacts draft too: they're the control arm that will later prove whether personalization pays rent.",
    kind: "info",
  },
  {
    route: "/draft",
    target: "draft-builder",
    title: "Per-track prompts, raw output kept",
    body:
      "Prompts are per-track — an MSP acquisition target reads different mail from a customer contact. Every run captures the raw model output even when it fails, so a bad run is a debuggable artifact with its prompt version attached, not a shrug.",
    kind: "info",
  },
  {
    route: "/draft/queue",
    target: "queue-table",
    title: "Try it: edit and approve a draft",
    body:
      "Open one of the demo drafts, tighten a sentence, and save — your edit diff lands in touch_edits as an implicit grade on the prompt that wrote it. Then tick Approve. Approval is explicit and attributed to you: nothing in this system sends because a model liked its own work.",
    kind: "try",
  },
  {
    route: "/draft/queue",
    target: "queue-send",
    title: "Send: the one irreversible act",
    body:
      "Everything upstream is reversible; send is not, so it's the most guarded moment in the pipeline: a daily cap, and a suppression check at the instant of sending — not just when the draft was queued. Leave the demo rows unsent; their .example addresses couldn't deliver anyway.",
    kind: "info",
  },
  {
    route: "/triage",
    target: "triage-card",
    title: "Try it: triage two demo replies",
    body:
      "Two replies came in. Mark the enthusiastic one P — positive. The 'please unsubscribe' one gets O — and watch it become a suppression instantly. An opt-out and a yes must never be the same data: one steers the next prompt revision, the other is a promise to never write again.",
    kind: "try",
  },
  {
    route: "/triage",
    target: "triage-suppressions",
    title: "Suppressions: guesses await confirmation",
    body:
      "Pending suppressions are the auto-matcher's guesses — inbound addresses it believes match a contact — waiting for your confirmation. Once confirmed, they're checked at send time, every time, forever. The machine proposes; the human decides; the table remembers.",
    kind: "info",
  },
  {
    route: "/outcomes",
    target: "outcomes-table",
    title: "Outcomes: the outer loop's scoreboard",
    body:
      "Dispositions per prompt version × track. Raw reply counts include opt-outs, so positive rate is the honest signal — a prompt that provokes unsubscribes doesn't get credit for 'engagement'. This table is what steers the next drafting prompt revision.",
    kind: "info",
  },
  {
    route: "/outcomes",
    target: "outcomes-hooks",
    title: "The rent check",
    body:
      "Verified hooks must beat no-hook on positive replies. If they don't within a quarter, the personalize stage folds back into drafting and the research time gets spent elsewhere. Every stage has to pay for itself with evidence — no stage survives on the theory that personalization ought to work.",
    kind: "info",
  },
  {
    route: "/runs",
    target: "runs-table",
    title: "Gate verdicts are history, not vibes",
    body:
      "Every batch's gate verdict lives here as gate_decisions rows: what was sampled, what was graded, what the error rate was, and what the gate decided. Six months from now, 'why did we trust that batch?' has an answer you can query instead of a memory you have to trust.",
    kind: "info",
  },
  {
    route: "/runs",
    target: null,
    title: "What got smarter",
    body:
      "While you walked through: your grades and corrections joined the eval set, the gate decision was recorded, your edit diff landed in touch_edits, your hook verdicts were stored, and two dispositions hit the scoreboard — all in tables, none in anyone's head. That's the system: judgment in, learning out, forever queryable. Clean up the demo rows whenever you're ready.",
    kind: "finish",
  },
];
