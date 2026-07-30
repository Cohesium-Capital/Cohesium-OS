import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nextAction, furthestStage, type FlowRun } from "./describe";

// nextAction is the whole of the operator's "what now?" — the runs list and the
// run detail page both render nothing else about progress. Its ordering is
// therefore load-bearing, and every clause in it was added because a real run
// stalled without it, so the cases below are worth pinning.

const run = (over: Partial<FlowRun> = {}): FlowRun => ({
  entry_kind: "run",
  id: "run-1",
  batch_id: "batch-1",
  module: "sourcing",
  status: "review_ready",
  executor: "runner",
  provider_label: "claude-code-runner",
  config: { mode: "research_customers" },
  error: null,
  created_at: "2026-07-30T03:38:10.515Z",
  finished_at: null,
  batch_label: "TPAs, Chicago metro",
  gate_status: "passed",
  sampled: 20,
  graded: 20,
  errors: 0,
  pending: 0,
  sourced: 20,
  discarded: 0,
  reviewed: 20,
  enriched: 20,
  personalized: 0,
  drafted: 0,
  sent: 0,
  replied: 0,
  drafts_created: 0,
  draftable: 0,
  awaiting_redraft: 0,
  run_seq: 30,
  run_mode_code: "C",
  run_code: "30-C",
  has_records: true,
  ...over,
});

describe("nextAction", () => {
  test("a Clay straggler does not strand the run", () => {
    // Run 30-C exactly: 19 of 20 writebacks landed, the twentieth never will.
    // The old rule (reviewed > enriched) left this on "Enrich via Clay" forever
    // while every later stage was ready — draftable was already 19.
    const action = nextAction(run({ reviewed: 20, enriched: 19, draftable: 19 }));
    assert.equal(action?.label, "Personalize");
    assert.match(action?.href ?? "", /^\/personalize\?run=run-1$/);
  });

  test("but nothing back at all still asks for the push", () => {
    // The honest reading of zero: either nobody pushed yet, or the push is
    // broken. Advancing here would hide both.
    assert.equal(nextAction(run({ reviewed: 20, enriched: 0 }))?.label, "Enrich via Clay");
  });

  test("one writeback is enough", () => {
    assert.equal(nextAction(run({ reviewed: 20, enriched: 1 }))?.label, "Personalize");
  });

  test("ungraded contacts outrank enrichment, and say what they unlock", () => {
    const action = nextAction(run({ pending: 4, reviewed: 20, enriched: 0 }));
    assert.equal(action?.label, "Grade 4 to unlock enrichment");
    assert.match(action?.href ?? "", /batch=batch-1/);
  });

  test("unreviewed contacts come before enrichment", () => {
    assert.equal(
      nextAction(run({ sourced: 20, reviewed: 12, enriched: 0 }))?.label,
      "Review the contacts",
    );
  });

  test("a rejected draft outranks the pipeline's default order", () => {
    const action = nextAction(
      run({ reviewed: 20, enriched: 20, personalized: 0, awaiting_redraft: 3 }),
    );
    assert.equal(action?.label, "Redraft 3");
  });

  test("a finished run has no next action", () => {
    assert.equal(
      nextAction(
        run({ reviewed: 20, enriched: 20, personalized: 20, drafted: 20, sent: 20 }),
      ),
      null,
    );
  });

  test("legacy imports get unscoped links, since their contacts carry no lineage", () => {
    const action = nextAction(run({ entry_kind: "import", reviewed: 20, enriched: 19 }));
    assert.equal(action?.href, "/personalize");
  });
});

describe("furthestStage", () => {
  test("reads the furthest stage any record reached, not the shallowest", () => {
    assert.equal(furthestStage(run({ enriched: 19, personalized: 2 }))?.key, "personalized");
  });

  test("a run that produced nothing has no stage", () => {
    assert.equal(furthestStage(run({ sourced: 0, reviewed: 0, enriched: 0 })), null);
  });
});
