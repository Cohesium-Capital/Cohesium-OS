import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../_auth";
import { withRls, asSupabase } from "@/lib/db/rls";
import { createRun } from "@/lib/runs/lifecycle";
import { MODE_RUN_LABEL } from "@/lib/sourcing/prompts";

// Start a sourcing run from the runner executor.
//
// The runner still goes through createRun rather than researching free-hand:
// that is what stamps the prompt_version, opens the batch, and records the
// rendered prompt. Runner output is therefore gradeable and attributable on
// exactly the same terms as a copy-paste run — the executor changes who does
// the typing, not whether the work is accounted for.

const BodySchema = z.object({
  mode: z.enum([
    "research_msps",
    "research_customers",
    "find_customers_for_msps",
    "find_advisors_for_msps",
  ]),
  region: z.string().trim().optional(),
  profile: z.string().trim().optional(),
  count: z.number().int().positive().max(500).optional(),
  countPer: z.number().int().positive().max(500).optional(),
  /** MSP ids to target (find_customers_for_msps / find_advisors_for_msps).
   *  Resolved to names here so the caller never has to carry our identifiers
   *  around. */
  mspIds: z.array(z.string().uuid()).optional(),
  label: z.string().trim().max(200).optional(),
});

type MspRow = { id: string; name: string; domain: string | null };

// Distinguishes "you asked for something that isn't there" (404) from a genuine
// failure (500) across the transaction boundary.
class NotFound extends Error {}

export async function POST(req: Request) {
  const g = await guard(req, BodySchema);
  if (!g.ok) return g.response;
  const { auth, body } = g;

  const kind =
    body.mode === "research_msps"
      ? "msp"
      : body.mode === "find_advisors_for_msps"
        ? "advisor"
        : "customer";

  if (
    (body.mode === "find_customers_for_msps" || body.mode === "find_advisors_for_msps") &&
    !body.mspIds?.length
  ) {
    return NextResponse.json(
      { error: `${body.mode} requires at least one entry in mspIds` },
      { status: 400 },
    );
  }

  try {
    // Resolving the MSPs and creating the run share one RLS transaction, so a
    // run can never be created against MSPs the caller cannot see, and a failure
    // partway leaves no orphaned batch.
    const { created, targetMspId } = await withRls(auth.ownerId, async (db) => {
      const supabase = asSupabase(db);

      let msps: MspRow[] = [];
      if (body.mspIds?.length) {
        // The token's workspace, not just RLS: a token pinned to workspace A
        // whose owner also belongs to B must not resolve B's MSPs into a run
        // config that every member of A can read.
        const { data, error } = await supabase
          .from("organizations")
          .select("id, name, domain")
          .eq("workspace_id", auth.workspaceId)
          .eq("kind", "msp")
          .in("id", body.mspIds);
        if (error) throw new Error(`could not load target companies: ${error.message}`);
        msps = (data ?? []) as MspRow[];
        const missing = body.mspIds.filter((id) => !msps.some((m) => m.id === id));
        if (missing.length) throw new NotFound(`unknown target company id(s): ${missing.join(", ")}`);
      }

      // A single target lets the run report new_for_target at ingest.
      const target = msps.length === 1 ? msps[0].id : null;

      const run = await createRun(supabase, {
        module: "sourcing",
        executor: "runner",
        apiTokenId: auth.tokenId,
        workspaceId: auth.workspaceId,
        createdBy: auth.ownerId,
        label:
          body.label ??
          `${kind === "msp" ? "Target Companies" : "Customers"} · ${MODE_RUN_LABEL[body.mode]} · runner`,
        config: {
          mode: body.mode,
          region: body.region ?? "",
          profile: body.profile ?? "",
          count: body.count,
          countPer: body.countPer,
          msps,
          kind,
          targetMspId: target,
        },
      });
      return { created: run, targetMspId: target };
    });

    return NextResponse.json({
      runId: created.runId,
      batchId: created.batchId,
      promptVersionId: created.promptVersionId,
      // The research brief. Follow it, then POST the JSON it asks for to
      // /api/sourcing/runs/<runId>/ingest.
      prompt: created.prompt,
      notes: created.notes,
      kind,
      // Echoed so the agent can pass it straight to /api/sourcing/known without
      // re-deriving the scoping rule.
      checkKnown: { kind, mspId: targetMspId },
    });
  } catch (e) {
    if (e instanceof NotFound) return NextResponse.json({ error: e.message }, { status: 404 });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not create run" },
      { status: 500 },
    );
  }
}
