// The ALLOWED_EMAILS gate, in one place so the two callers cannot disagree.
//
// It used to be enforced only in /auth/callback. Supabase's Site URL sends magic
// links to /login?code=…, which is exchanged in the BROWSER (the PKCE verifier
// lives in that browser's storage, so the server cannot do it), and that path
// never consulted the list — so on the route every real sign-in actually takes,
// the allowlist did nothing at all.
//
// A redirect at sign-in was never the right boundary anyway: it guards the
// moment a session is created, not the requests that use it. The check now runs
// in the proxy, on every request, which is the only place that is true of.

/** Parsed once per process; an unset or empty variable means no restriction. */
export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this address permitted to use the app at all?
 *
 * Note what this is NOT: it is an instance-level bouncer, not authorization.
 * What a signed-in person can see is decided by workspace membership and RLS.
 * With tenancy in place this list is mostly vestigial — leaving it unset is a
 * reasonable choice — but while it exists it should mean something.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const allowed = allowedEmails();
  if (!allowed.length) return true;
  if (!email) return false;
  return allowed.includes(email.trim().toLowerCase());
}
