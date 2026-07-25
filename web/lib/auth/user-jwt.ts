// Mints a short-lived Supabase user JWT.
//
// This is what lets a token-authenticated caller run under real row-level
// security instead of the service role. Supabase signs its user JWTs with HS256
// over the project's JWT secret, so we can produce an equivalent one with Web
// Crypto and no JWT dependency. PostgREST then resolves auth.uid() from `sub`
// exactly as it does for a browser session.
//
// Kept free of "server-only" and of Supabase imports so it can be unit-tested:
// a malformed token here fails as an opaque 401 from PostgREST, which is a
// miserable thing to debug in production.

// Short by design. The JWT lives for one request, so a leaked API token still
// has to go through our API — where it can be revoked — rather than becoming a
// long-lived database credential.
export const JWT_TTL_SECONDS = 300;

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

export type UserJwtClaims = {
  sub: string;
  role: "authenticated";
  aud: "authenticated";
  iat: number;
  exp: number;
};

/** Sign a Supabase-compatible user JWT for `userId`. */
export async function mintUserJwt(
  userId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const claims: UserJwtClaims = {
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + JWT_TTL_SECONDS,
  };
  const data = `${header}.${b64urlJson(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
