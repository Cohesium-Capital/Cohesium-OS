import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../_auth";
import { loadOrgIndex, partitionCandidates } from "@/lib/sourcing/known";

// "Which of these companies do we already have?" — the call that removes the
// prompt cap.
//
// A pasted prompt has to carry its exclusion list, so that list is bounded by
// what fits in a chat window (and, well before that, by how many names a model
// will actually keep track of). A runner can ask instead, so the comparison
// happens here against EVERY organization we hold, with no cap and no
// truncation. The prompt then carries an inclusion list bounded by the number
// of results requested rather than by the size of the database.
//
// Runs under the token owner's RLS: the index is built from the rows that user
// can see, so this stays correct when tenancy lands without any change here.

const BodySchema = z.object({
  kind: z.enum(["msp", "customer"]),
  candidates: z
    .array(
      z.object({
        name: z.string().trim().min(1, "name required"),
        domain: z.string().trim().nullish(),
      }),
    )
    .min(1, "no candidates")
    // In-memory matching, so the ceiling is request size rather than cost. It
    // exists to keep one request from being unboundedly large; the agent can
    // call as many times as it likes, which is why there is still no cap on the
    // total set that can be checked.
    .max(2000, "at most 2000 candidates per request — send them in chunks"),
  /**
   * Scope the question to one MSP's client list (the find-customers-for-MSP
   * mode). A company we already hold as MSP A's client is still a new find
   * under MSP B, so without this the check would over-exclude.
   */
  mspId: z.string().uuid().nullish(),
});

export async function POST(req: Request) {
  const g = await guard(req, BodySchema);
  if (!g.ok) return g.response;
  const { auth, body } = g;

  let index;
  try {
    index = await loadOrgIndex(auth.supabase, body.kind);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load organizations" },
      { status: 500 },
    );
  }

  const { known, fresh } = partitionCandidates(index, body.candidates, {
    mspId: body.mspId ?? null,
  });

  return NextResponse.json({
    // `new` is the list to actually research. Named for what the caller does
    // with it, and returned in full rather than as a count.
    new: fresh,
    known,
    counts: {
      submitted: body.candidates.length,
      // submitted minus deduped-within-request, hence computed not assumed
      considered: known.length + fresh.length,
      known: known.length,
      new: fresh.length,
      comparedAgainst: index.rows.length,
    },
  });
}
