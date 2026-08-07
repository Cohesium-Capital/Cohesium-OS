import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SourcedContactSchema } from "../contracts";

// email/phone on a sourced contact. Most research never surfaces them and Clay
// fills them later, but a hand-built target list often arrives with both — and
// carrying them costs nothing while re-finding them costs a Clay credit each.

const parse = (c: Record<string, unknown>) => SourcedContactSchema.parse(c);
const base = { full_name: "Russell Hooker", persona: "owner", confidence: "high" };

describe("sourced contact email", () => {
  test("is lowercased at rest, so reply capture can match it", () => {
    // The IMAP poll lowercases the incoming sender address before comparing.
    // A mixed-case stored address silently fails that match: the reply is
    // dropped and the drip keeps sending to someone who already answered.
    assert.equal(parse({ ...base, email: "Russ@Nova401k.COM" }).email, "russ@nova401k.com");
  });

  test("surrounding whitespace is trimmed", () => {
    assert.equal(parse({ ...base, email: "  russ@nova401k.com  " }).email, "russ@nova401k.com");
  });

  test("a value that cannot be an address falls back to null, not an error", () => {
    // Hand-built sheets put prose in this column ("not found", "see notes").
    // One bad cell must not reject the whole row — and must never reach the
    // send path, where an invalid address costs a bounce.
    for (const junk of ["not found", "none", "—", "see notes"]) {
      assert.equal(parse({ ...base, email: junk }).email, null, junk);
    }
  });

  test("empty and absent both read as null", () => {
    assert.equal(parse({ ...base, email: "" }).email, null);
    assert.equal(parse({ ...base, email: null }).email, null);
    assert.equal(parse(base).email ?? null, null);
  });
});

describe("sourced contact phone", () => {
  test("is carried verbatim — formatting is not ours to normalize", () => {
    assert.equal(parse({ ...base, phone: "(713) 881-9313" }).phone, "(713) 881-9313");
  });

  test("empty reads as null", () => {
    assert.equal(parse({ ...base, phone: "   " }).phone, null);
  });
});

describe("neither field is required", () => {
  test("a contact with no details still parses", () => {
    const c = parse({ full_name: "Paul Lovell", persona: "owner", confidence: "medium" });
    assert.equal(c.email ?? null, null);
    assert.equal(c.phone ?? null, null);
    assert.equal(c.full_name, "Paul Lovell");
  });
});

// The rule contactRow() applies when writing the contact. Stated here as the
// intent it encodes: Clay eligibility keys off enrichment_status, so the flip
// must follow EMAIL alone. A LinkedIn URL is not a substitute — most sourced
// contacts have one, and marking those 'enriched' would quietly starve Clay of
// exactly the contacts it exists to complete.
describe("enrichment_status derived from email", () => {
  const statusFor = (email: string | null) => (email ? "enriched" : "pending");

  test("an email means there is nothing for Clay to find", () => {
    assert.equal(statusFor(parse({ ...base, email: "russ@nova401k.com" }).email ?? null), "enriched");
  });

  test("no email leaves the contact eligible for Clay", () => {
    assert.equal(statusFor(parse(base).email ?? null), "pending");
  });

  test("a junk email does NOT count as enriched", () => {
    assert.equal(statusFor(parse({ ...base, email: "not found" }).email ?? null), "pending");
  });

  test("a LinkedIn URL alone does not count as enriched", () => {
    const c = parse({ ...base, linkedin_url: "https://linkedin.com/in/russellhooker" });
    assert.equal(statusFor(c.email ?? null), "pending");
  });
});
