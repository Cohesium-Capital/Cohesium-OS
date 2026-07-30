import { NextResponse } from "next/server";
import { z } from "zod";
import { guard, INGEST_SCOPE } from "../../../_auth";
import { withRls, asSupabase } from "@/lib/db/rls";
import { ingestRun } from "@/lib/runs/lifecycle";

// Post a run's output back instead of pasting it into the app.
//
// Module-generic on purpose: ingestRun already looks the module up from the run
// row and dispatches through the registry, so hooks and drafts land through the
// same door as organizations, with the same contract validation, the same
// evidence gate, the same batch tagging and the same deterministic grading
// sample. There is no shortcut here — the executor changes, not the accounting.
//
// The sourcing runner keeps its own /api/sourcing/runs/<id>/ingest, because that
// path also STARTS runs (it can decide what to research from a region and a
// profile). Personalize and Draft cannot: their configs come from database
// queries about which contacts need work, so the operator starts those in the UI
// and only the results come back here.

const BodySchema = z
  .record(z.string(), z.unknown())
  .refine((b) => Object.keys(b).length > 0, "empty body");

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Body validation stays permissive: the module's own parser produces the
  // specific, fixable error ("hook required when kind is ...") where a schema
  // here could only produce a generic dump of a shape it half-knows.
  const g = await guard(req, BodySchema, INGEST_SCOPE);
  if (!g.ok) return g.response;
  const { auth } = g;

  // requireEvidence is transport, not payload: split it out so it never reaches
  // a module's parser as a stray field of the contract.
  const { requireEvidence, ...payload } = g.body;

  let outcome;
  try {
    outcome = await withRls(auth.ownerId, async (db) => {
      const supabase = asSupabase(db);

      // Who authored this run, not who holds the token.
      //
      // For drafting the difference is not cosmetic: createdBy becomes
      // touches.created_by, and the email cron resolves the From: mailbox from
      // it (app/api/cron/email/route.ts). The BODY was already rendered with the
      // run creator's sign-off, because prepareConfig overlays their sender
      // identity at run start (migrations 045/046). Stamping the token owner
      // instead would send a message signed by one person from another's
      // mailbox, and mis-attribute its reply rate on top.
      //
      // Falls back to the token owner for a run that names nobody — a headless
      // run has no other honest answer. The read is inside the transaction, so
      // RLS has already established the caller can see this run at all.
      const { data: run } = await supabase
        .from("runs")
        .select("created_by")
        .eq("id", id)
        .maybeSingle();

      return ingestRun(supabase, {
        runId: id,
        rawText: JSON.stringify(payload),
        createdBy: (run?.created_by as string | null) ?? auth.ownerId,
        // Deliberately not forced true, unlike the sourcing route: the default
        // is per-module (requiresEvidence in lifecycle.ts), and drafting has no
        // evidence to require. An explicit flag still wins if one is sent.
        requireEvidence: typeof requireEvidence === "boolean" ? requireEvidence : undefined,
        // The token acts in exactly one workspace (migration 028); enforce that
        // here, not only wherever the run was created.
        expectedWorkspaceId: auth.workspaceId,
      });
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "ingest failed", inserted: 0 },
      { status: 500 },
    );
  }

  // A failed ingest is a 422, not a 200 with ok:false — the agent must be able
  // to tell "landed" from "rejected" without parsing the body, or it will
  // happily report success on a run that imported nothing.
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 422 });
}
