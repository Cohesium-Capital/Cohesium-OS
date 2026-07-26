import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../_auth";
import { ingestRun } from "@/lib/runs/lifecycle";

// Land a runner run's results. Deliberately the same ingestRun the copy-paste
// flow calls: same contract validation, same evidence gate, same batch tagging,
// same deterministic grading sample. A runner run is not a trusted shortcut —
// it earns its rows the same way, and its output is graded the same way.

const BodySchema = z.object({
  // The sourcing contract, validated properly by the module's own parser. Kept
  // permissive here so contract violations produce the module's specific,
  // fixable error rather than a generic schema dump.
  organizations: z.array(z.unknown()).min(1, "no organizations"),
  /** Drop rows with no source_url instead of keeping them flagged. Defaults on
   *  for the runner: an agent has no excuse for an unsourced row. */
  requireEvidence: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(req, BodySchema);
  if (!g.ok) return g.response;
  const { auth, body } = g;

  const outcome = await ingestRun(auth.supabase, {
    runId: id,
    rawText: JSON.stringify({ organizations: body.organizations }),
    createdBy: auth.ownerId,
    requireEvidence: body.requireEvidence ?? true,
  });

  // A failed ingest is a 422, not a 200 with ok:false — the agent must be able
  // to tell "landed" from "rejected" without parsing the body, or it will
  // happily report success on a run that imported nothing.
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 422 });
}
