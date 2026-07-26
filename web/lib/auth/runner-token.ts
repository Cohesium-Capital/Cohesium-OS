import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, TOKEN_PREFIX } from "./token-hash";
import { mintUserJwt } from "./user-jwt";

// Authentication for non-browser callers (the runner executor: a Claude Code
// session driving a sourcing run).
//
// The central rule: a runner request must be no more privileged than the person
// who created its token. So a token is not an authorization by itself — it is a
// lookup key for a user id, from which we mint a short-lived Supabase user JWT
// and build a normal RLS-bound client. Every query the runner makes then runs
// under the same policies as that user's browser session. This is what keeps
// the path safe to extend to multiple tenants: there is no code path where the
// runner sees rows its owner could not.
//
// The service-role client appears exactly once here — to look the token hash up
// before any identity exists. It is never returned to a caller.

export type RunnerAuth = {
  ownerId: string;
  tokenId: string;
  scopes: string[];
  /** RLS-bound client acting as the token's owner. */
  supabase: SupabaseClient;
};

export type AuthFailure = { error: string; status: 401 | 403 | 500 };

// A client that carries the minted user JWT. The anon key is the project
// identifier; Authorization is the identity, so RLS sees auth.uid() = ownerId.
function clientAsUser(jwt: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolve a request's bearer token to an RLS-bound client for its owner.
 * Returns an AuthFailure (never throws) so route handlers can map it straight
 * to a response.
 */
export async function authenticateRunner(
  req: Request,
  requiredScope: string,
): Promise<RunnerAuth | AuthFailure> {
  const raw = bearer(req);
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) {
    return { error: "missing or malformed API token", status: 401 };
  }

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    // Fail closed. Without the secret we cannot mint a user-scoped JWT, and the
    // only alternative — falling back to the service role — is precisely the
    // RLS bypass this module exists to avoid.
    return { error: "runner API is not configured (SUPABASE_JWT_SECRET unset)", status: 500 };
  }

  // Service-role lookup: unavoidable, since no identity exists yet. Scoped to
  // reading one row of the token table by hash.
  const admin = createAdminClient();
  const { data: token, error } = await admin
    .from("api_tokens")
    .select("id, owner_id, scopes, expires_at, revoked_at")
    .eq("token_hash", await hashToken(raw))
    .maybeSingle();
  if (error) return { error: `token lookup failed: ${error.message}`, status: 500 };
  if (!token) return { error: "unknown API token", status: 401 };
  if (token.revoked_at) return { error: "API token has been revoked", status: 401 };
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    return { error: "API token has expired", status: 401 };
  }

  const scopes = (token.scopes as string[] | null) ?? [];
  if (!scopes.includes(requiredScope)) {
    return { error: `API token lacks the "${requiredScope}" scope`, status: 403 };
  }

  // Usage stamp is diagnostic, not transactional — a failure here must not deny
  // an otherwise valid request.
  void admin
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", token.id)
    .then(() => undefined);

  const jwt = await mintUserJwt(token.owner_id as string, secret);
  return {
    ownerId: token.owner_id as string,
    tokenId: token.id as string,
    scopes,
    supabase: clientAsUser(jwt),
  };
}

export const isAuthFailure = (r: RunnerAuth | AuthFailure): r is AuthFailure =>
  (r as AuthFailure).status !== undefined;
