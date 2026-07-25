import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mintToken, hashToken, TOKEN_PREFIX } from "./token-hash";

describe("runner token minting", () => {
  test("mints a prefixed token whose hash matches the raw value", async () => {
    const t = await mintToken();
    assert.ok(t.raw.startsWith(TOKEN_PREFIX));
    assert.equal(t.hash, await hashToken(t.raw));
  });

  test("the stored prefix is a strict, short leading segment of the raw token", async () => {
    // It identifies a token in the UI; it must never be enough to reconstruct one.
    const t = await mintToken();
    assert.ok(t.raw.startsWith(t.prefix));
    assert.ok(t.prefix.length < t.raw.length / 3);
  });

  test("tokens are unique across mints", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add((await mintToken()).raw);
    assert.equal(seen.size, 50);
  });

  test("hashing is stable and differs per input", async () => {
    assert.equal(await hashToken("cin_abc"), await hashToken("cin_abc"));
    assert.notEqual(await hashToken("cin_abc"), await hashToken("cin_abd"));
  });

  test("the hash is sha256 hex, so nothing reversible is persisted", async () => {
    const h = await hashToken("cin_abc");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes("cin_"));
  });
});
