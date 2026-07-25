import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintUserJwt, JWT_TTL_SECONDS, type UserJwtClaims } from "./user-jwt";

// A wrong JWT surfaces as an opaque 401 from PostgREST, so verify the structure
// and signature here rather than discovering it against a live project.

const SECRET = "super-secret-jwt-signing-key-for-tests";
const USER = "11111111-2222-3333-4444-555555555555";

const decode = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

describe("mintUserJwt", () => {
  test("produces three base64url segments with no padding", async () => {
    const jwt = await mintUserJwt(USER, SECRET);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);
    for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/);
  });

  test("declares HS256, the algorithm Supabase verifies with", async () => {
    const [header] = (await mintUserJwt(USER, SECRET)).split(".");
    assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });
  });

  test("carries the claims PostgREST needs to resolve auth.uid()", async () => {
    const [, payload] = (await mintUserJwt(USER, SECRET, 1_700_000_000)).split(".");
    const claims = decode(payload) as UserJwtClaims;
    assert.equal(claims.sub, USER);
    assert.equal(claims.role, "authenticated");
    assert.equal(claims.aud, "authenticated");
    assert.equal(claims.iat, 1_700_000_000);
    assert.equal(claims.exp, 1_700_000_000 + JWT_TTL_SECONDS);
  });

  test("signature verifies against the secret with an independent HMAC", async () => {
    const jwt = await mintUserJwt(USER, SECRET);
    const [h, p, sig] = jwt.split(".");
    const expected = createHmac("sha256", SECRET)
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert.equal(sig, expected);
  });

  test("a different secret yields a different signature", async () => {
    const a = await mintUserJwt(USER, SECRET, 1_700_000_000);
    const b = await mintUserJwt(USER, "another-secret", 1_700_000_000);
    assert.notEqual(a.split(".")[2], b.split(".")[2]);
  });

  test("the token is short-lived, so a leak is not a durable DB credential", async () => {
    assert.ok(JWT_TTL_SECONDS <= 900);
  });
});
