// Token minting and hashing. Kept free of "server-only" and of any Supabase
// import so it can be unit-tested directly and reused by both the auth path
// (hash an incoming token) and the creation path (mint a new one).

export const TOKEN_PREFIX = "cin_";

// Length of the leading segment stored in the clear for display. Long enough to
// identify a token in a list, far too short to brute-force the remainder.
const PREFIX_DISPLAY_LEN = TOKEN_PREFIX.length + 8;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * SHA-256 hex of a raw token. Only this is persisted: the raw value is shown
 * once at creation and is unrecoverable afterwards, so a database leak yields
 * no usable credentials. A plain hash (not a password KDF) is right here —
 * the input is 256 bits of CSPRNG output, so there is no dictionary to attack.
 */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return toHex(new Uint8Array(digest));
}

export type MintedToken = { raw: string; hash: string; prefix: string };

/** Generate a new token: 32 random bytes, hex-encoded, behind a readable prefix. */
export async function mintToken(): Promise<MintedToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = `${TOKEN_PREFIX}${toHex(bytes)}`;
  return { raw, hash: await hashToken(raw), prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}
