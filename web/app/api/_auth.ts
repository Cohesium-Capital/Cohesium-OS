import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRunner, isAuthFailure, type RunnerAuth } from "@/lib/auth/runner-token";

// Shared entry sequence for the runner API: authenticate the bearer token into
// an RLS-bound client, then validate the JSON body. Both failures return the
// same shape so the agent driving the run gets an actionable message rather
// than a bare status code — it has to be able to diagnose itself.
//
// Lives here rather than under sourcing/ because the ingest route is now
// module-generic: hooks and drafts come back through the same door.

/** Scope for the three sourcing endpoints: start a run, check candidates, ingest. */
export const SOURCING_SCOPE = "sourcing";

/**
 * Scope for posting a module's output back to a run started in the UI.
 *
 * Separate from `sourcing` on purpose, and not a widening of it: a drafting
 * ingest writes touches — message bodies — which is a broader grant than
 * researching companies. It is still bounded by the send queue (every draft
 * lands unapproved), but it deserves its own opt-in rather than arriving
 * silently on credentials minted for sourcing.
 */
export const INGEST_SCOPE = "ingest";

export type Guarded<T> =
  | { ok: true; auth: RunnerAuth; body: T }
  | { ok: false; response: NextResponse };

export type Authorized =
  | { ok: true; auth: RunnerAuth }
  | { ok: false; response: NextResponse };

const fail = (error: string, status: number, hint?: string) =>
  NextResponse.json({ error, ...(hint ? { hint } : {}) }, { status });

/**
 * Authenticate a bearer token without reading a body.
 *
 * Split out of `guard` for the GET routes: `guard` always parses JSON, so a
 * request with no body would fail as "invalid JSON body" — a misleading 400 on
 * a request that was perfectly well formed. The token diagnostics live here so
 * both paths give the agent the same actionable message.
 */
export async function authorize(
  req: Request,
  scope: string = SOURCING_SCOPE,
): Promise<Authorized> {
  const auth = await authenticateRunner(req, scope);
  if (isAuthFailure(auth)) {
    return {
      ok: false,
      response: fail(
        auth.error,
        auth.status,
        auth.status === 401
          ? "Send Authorization: Bearer <token>. Create a token in the app under Settings → API tokens."
          : auth.status === 403
            ? // A token minted before this scope existed is the likely cause, and
              // it cannot be granted retroactively — scopes are fixed at mint.
              `This token was created without the "${scope}" scope. Mint a new one in the app under Settings → API tokens; scopes are fixed when a token is created.`
            : undefined,
      ),
    };
  }
  return { ok: true, auth };
}

export async function guard<T>(
  req: Request,
  schema: z.ZodType<T>,
  scope: string = SOURCING_SCOPE,
): Promise<Guarded<T>> {
  const authorized = await authorize(req, scope);
  if (!authorized.ok) return { ok: false, response: authorized.response };
  const { auth } = authorized;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: fail("invalid JSON body", 400) };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      ok: false,
      response: fail(`validation failed — ${issues.join("; ")}`, 400),
    };
  }

  return { ok: true, auth, body: parsed.data };
}
