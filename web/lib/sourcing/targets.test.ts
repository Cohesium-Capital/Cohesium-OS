import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pageParams, DEFAULT_LIMIT, MAX_LIMIT } from "./targets";

// Query-string paging for /api/sourcing/targets. Everything here arrives as an
// untrusted string from an agent that guessed at the parameter names, so the
// rule is: clamp, never throw. A 400 on a malformed `limit` would strand a
// runner mid-loop over a value it can neither see nor fix.

describe("pageParams", () => {
  test("absent values take the defaults", () => {
    assert.deepEqual(pageParams(null, null), { limit: DEFAULT_LIMIT, offset: 0 });
  });

  test("valid values pass through", () => {
    assert.deepEqual(pageParams("50", "100"), { limit: 50, offset: 100 });
  });

  test("limit is capped rather than honoured", () => {
    // Otherwise ?limit=100000 is a way to ask for the whole table in one
    // response on a large tenant.
    assert.equal(pageParams("100000", null).limit, MAX_LIMIT);
  });

  test("garbage falls back instead of erroring", () => {
    for (const junk of ["abc", "", "NaN", "1e9999", "--5"]) {
      assert.equal(pageParams(junk, junk).limit, DEFAULT_LIMIT, `limit for ${junk}`);
      assert.equal(pageParams(junk, junk).offset, 0, `offset for ${junk}`);
    }
  });

  test("zero and negative are not honoured", () => {
    // limit=0 would return an empty page forever and read as "no targets";
    // a negative offset would make .range() throw inside PostgREST.
    assert.equal(pageParams("0", null).limit, DEFAULT_LIMIT);
    assert.equal(pageParams("-10", null).limit, DEFAULT_LIMIT);
    assert.equal(pageParams(null, "-10").offset, 0);
  });

  test("only plain integers are honoured", () => {
    // parseInt would read "1e9999" as 1 and "10.9" as 10, handing back a page
    // size nobody asked for. One row looks like "this workspace has one target",
    // which is the kind of quiet wrongness worth a strict parse to avoid.
    assert.equal(pageParams("10.9", null).limit, DEFAULT_LIMIT);
    assert.equal(pageParams("1e9999", null).limit, DEFAULT_LIMIT);
    assert.equal(pageParams(null, "5.9").offset, 0);
    assert.equal(pageParams(" 25 ", null).limit, 25, "surrounding space is tolerated");
  });
});
