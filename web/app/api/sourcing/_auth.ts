import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRunner, isAuthFailure, type RunnerAuth } from "@/lib/auth/runner-token";

// Shared entry sequence for the runner API: authenticate the bearer token into
// an RLS-bound client, then validate the JSON body. Both failures return the
// same shape so the agent driving the run gets an actionable message rather
// than a bare status code — it has to be able to diagnose itself.

export const SCOPE = "sourcing";

export type Guarded<T> =
  | { ok: true; auth: RunnerAuth; body: T }
  | { ok: false; response: NextResponse };

const fail = (error: string, status: number, hint?: string) =>
  NextResponse.json({ error, ...(hint ? { hint } : {}) }, { status });

export async function guard<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<Guarded<T>> {
  const auth = await authenticateRunner(req, SCOPE);
  if (isAuthFailure(auth)) {
    return {
      ok: false,
      response: fail(
        auth.error,
        auth.status,
        auth.status === 401
          ? "Send Authorization: Bearer <token>. Create a token in the app under Settings → API tokens."
          : undefined,
      ),
    };
  }

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
