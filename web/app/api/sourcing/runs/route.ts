import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../_auth";
import { createRun } from "@/lib/runs/lifecycle";

// Start a sourcing run from the runner executor.
//
// The runner still goes through createRun rather than researching free-hand:
// that is what stamps the prompt_version, opens the batch, and records the
// rendered prompt. Runner output is therefore gradeable and attributable on
// exactly the same terms as a copy-paste run — the executor changes who does
// the typing, not whether the work is accounted for.

const BodySchema = z.object({
  mode: z.enum(["research_msps", "research_customers", "find_customers_for_msps"]),
  region: z.string().trim().optional(),
  profile: z.string().trim().optional(),
  count: z.number().int().positive().max(500).optional(),
  countPer: z.number().int().positive().max(500).optional(),
  /** MSP ids to target (find_customers_for_msps). Resolved to names here so the
   *  caller never has to carry our identifiers around. */
  mspIds: z.array(z.string().uuid()).optional(),
  label: z.string().trim().max(200).optional(),
});

export async function POST(req: Request) {
  const g = await guard(req, BodySchema);
  if (!g.ok) return g.response;
  const { auth, body } = g;

  const kind = body.mode === "research_msps" ? "msp" : "customer";

  // Resolve targeted MSPs under the caller's RLS.
  let msps: { id: string; name: string; domain: string | null }[] = [];
  if (body.mspIds?.length) {
    const { data, error } = await auth.supabase
      .from("organizations")
      .select("id, name, domain")
      .eq("kind", "msp")
      .in("id", body.mspIds);
    if (error) {
      return NextResponse.json({ error: `could not load MSPs: ${error.message}` }, { status: 500 });
    }
    msps = (data ?? []) as typeof msps;
    const missing = body.mspIds.filter((id) => !msps.some((m) => m.id === id));
    if (missing.length) {
      return NextResponse.json(
        { error: `unknown MSP id(s): ${missing.join(", ")}` },
        { status: 404 },
      );
    }
  }

  if (body.mode === "find_customers_for_msps" && !msps.length) {
    return NextResponse.json(
      { error: "find_customers_for_msps requires at least one entry in mspIds" },
      { status: 400 },
    );
  }

  // A single target lets the run report new_for_target at ingest.
  const targetMspId = msps.length === 1 ? msps[0].id : null;

  try {
    const created = await createRun(auth.supabase, {
      module: "sourcing",
      executor: "runner",
      apiTokenId: auth.tokenId,
      createdBy: auth.ownerId,
      label: body.label ?? `${kind === "msp" ? "MSPs" : "Customers"} · ${body.mode.replace(/_/g, " ")} · runner`,
      config: {
        mode: body.mode,
        region: body.region ?? "",
        profile: body.profile ?? "",
        count: body.count,
        countPer: body.countPer,
        msps,
        kind,
        targetMspId,
      },
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not create run" },
      { status: 500 },
    );
  }
}
