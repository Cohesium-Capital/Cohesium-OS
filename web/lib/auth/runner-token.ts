import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, TOKEN_PREFIX } from "./token-hash";

// Authentication for non-browser callers (the runner executor: a Claude Code
// session driving a sourcing run).
//
// The central rule: a runner request must be no more privileged than the person
// who created its token. So a token is not an authorization by itself — it is a
// lookup key for a user id. The route then opens a Postgres transaction that
// assumes the `authenticated` role with that user's claims (see lib/db/rls.ts),
// and every query inside runs under the same policies as their browser session.
// There is no code path where the runner sees rows its owner could not.
//
// Postgres enforces this rather than a signed token, deliberately: Supabase is
// moving to asymmetric JWT signing keys, so minting our own user JWTs is a
// mechanism with an expiry date. Role + claims is not.
//
// The service-role client appears exactly once here — to look the token hash up
// before any identity exists. It never reaches a caller, and it is never used
// to read business data.

export type RunnerAuth = {
  ownerId: string;
  tokenId: string;
  /** The workspace this token acts in. A token writes rows, and owner alone no
   *  longer says where they land once a user belongs to more than one. */
  workspaceId: string;
  scopes: string[];
};

export type AuthFailure = { error: string; status: 401 | 403 | 500 };

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolve a request's bearer token to its owning user. Returns an AuthFailure
 * (never throws) so route handlers can map it straight to a response.
 */
export async function authenticateRunner(
  req: Request,
  requiredScope: string,
): Promise<RunnerAuth | AuthFailure> {
  const raw = bearer(req);
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) {
    return { error: "missing or malformed API token", status: 401 };
  }

  if (!process.env.SUPABASE_DB_URL) {
    // Fail closed. Without a database connection we cannot assume the
    // authenticated role, and the only alternative — serving the request with
    // the service-role client — is the RLS bypass this module exists to avoid.
    return { error: "runner API is not configured (SUPABASE_DB_URL unset)", status: 500 };
  }

  // Service-role lookup: unavoidable, since no identity exists yet. Scoped to
  // reading one row of the token table by hash.
  const admin = createAdminClient();
  const { data: token, error } = await admin
    .from("api_tokens")
    .select("id, owner_id, workspace_id, scopes, expires_at, revoked_at")
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

  // A token without a workspace pin cannot say where its writes land — refuse
  // it rather than cast null onward (the column predates NOT NULL; migration
  // 042 tightens it, this guards any stragglers).
  if (!token.workspace_id) {
    return { error: "token has no workspace — mint a new one in Settings", status: 401 };
  }
  return {
    ownerId: token.owner_id as string,
    tokenId: token.id as string,
    workspaceId: token.workspace_id as string,
    scopes,
  };
}

export const isAuthFailure = (r: RunnerAuth | AuthFailure): r is AuthFailure =>
  (r as AuthFailure).status !== undefined;
