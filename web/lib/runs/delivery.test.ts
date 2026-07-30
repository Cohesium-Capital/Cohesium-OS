import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deliveryFooter } from "./delivery";

// The footer is the only thing standing between an agent and a silent failure:
// it is where the agent learns the run's address, and what a 422 means. Every
// assertion here is a line an agent would otherwise have to guess.

const footer = deliveryFooter("run-123", "https://app.example.test");

describe("agent-mode delivery footer", () => {
  test("addresses the run it was built for", () => {
    assert.match(footer, /https:\/\/app\.example\.test\/api\/runs\/run-123\/ingest/);
  });

  test("sends the token from the environment, never a literal", () => {
    assert.match(footer, /Authorization: Bearer \$COHESIUM_API_TOKEN/);
    assert.ok(!/cin_/.test(footer), "no token value can appear in a prompt");
  });

  test("says what 422 means, because ok:false does not raise", () => {
    // The failure this exists to prevent: an agent posting, seeing a response
    // body, and reporting success over a run that imported nothing.
    assert.match(footer, /422 means NOTHING was imported/);
    assert.match(footer, /Never report success on a 422/);
    assert.match(footer, /200 means the rows landed/);
  });

  test("explains the 403 an older token will produce", () => {
    // Scopes are fixed at mint, so the fix is a new token — not a setting to
    // toggle. An agent that does not know this retries the same 403 forever.
    assert.match(footer, /"ingest" scope/);
    assert.match(footer, /Settings → API tokens/);
  });

  test("says a run ingests once, so a retry needs a new run", () => {
    assert.match(footer, /start a new run rather than retrying/);
  });

  test("keeps the body out of the command line", () => {
    // A merged hooks payload for 30 contacts is far past comfortable inline
    // quoting, and a mangled quote reads as a contract violation.
    assert.match(footer, /--data-binary @result\.json/);
  });

  test("begins with a separator so it cannot blur into the brief", () => {
    assert.match(footer, /^\n\n---\n/);
  });
});
