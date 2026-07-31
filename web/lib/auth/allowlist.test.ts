import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { allowedEmails, isAllowedEmail } from "./allowlist";

// This decides who may use the instance at all, and it is read from an
// environment variable that a human types by hand — so the parsing is where it
// will go wrong, not the comparison.

const original = process.env.ALLOWED_EMAILS;
const set = (v: string | undefined) => {
  if (v === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = v;
};
afterEach(() => set(original));

describe("the email allowlist", () => {
  test("unset means no restriction — the app is not accidentally locked", () => {
    set(undefined);
    assert.equal(isAllowedEmail("anyone@example.com"), true);
    assert.deepEqual(allowedEmails(), []);
  });

  test("empty or whitespace-only is also no restriction, not a lockout", () => {
    // A variable someone cleared by deleting the value rather than the key must
    // not lock every user out of a working deployment.
    for (const value of ["", "   ", ",", " , ,"]) {
      set(value);
      assert.equal(isAllowedEmail("anyone@example.com"), true, `for ${JSON.stringify(value)}`);
    }
  });

  test("matching ignores case and the spaces around a hand-typed list", () => {
    set(" Ripley@Cohesiumcap.com , saagar@iliumholdings.com ");
    assert.equal(isAllowedEmail("ripley@cohesiumcap.com"), true);
    assert.equal(isAllowedEmail("  SAAGAR@iliumholdings.com "), true);
  });

  test("an address that is not listed is refused", () => {
    set("ripley@cohesiumcap.com");
    assert.equal(isAllowedEmail("someone@else.com"), false);
  });

  test("a session with no email is refused once a list exists", () => {
    // Not hypothetical: a phone-only or anonymous Supabase user has no email,
    // and "no email" must not read as "not excluded".
    set("ripley@cohesiumcap.com");
    assert.equal(isAllowedEmail(null), false);
    assert.equal(isAllowedEmail(undefined), false);
    assert.equal(isAllowedEmail(""), false);
  });

  test("no email is fine when there is no list", () => {
    set(undefined);
    assert.equal(isAllowedEmail(null), true);
  });

  test("a domain is not a wildcard", () => {
    // Worth pinning: someone will eventually try "@iliumholdings.com" and expect
    // it to admit the domain. It admits exactly one nonexistent address.
    set("@iliumholdings.com");
    assert.equal(isAllowedEmail("saagar@iliumholdings.com"), false);
  });
});
