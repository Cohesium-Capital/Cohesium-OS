import { NextResponse } from "next/server";
import { authorize } from "../../_auth";
import { withRls, asSupabase } from "@/lib/db/rls";
import { listTargets, pageParams } from "@/lib/sourcing/targets";

// "Which target companies do we hold?" — the lookup that made
// find_customers_for_msps usable from the runner.
//
// That mode takes `mspIds`, which are UUIDs, and until this route existed there
// was no way to obtain one over the API: /api/sourcing/known matches a name
// against every org we hold but reports the match by NAME, so an agent asked to
// source customers for a named firm could not start the run. The operator had to
// read ids out of the database by hand and paste them in, which is a workaround
// for a missing endpoint rather than a way to use the product.
//
// Read-only, so it needs no body — hence `authorize` rather than `guard`, which
// would reject a bodyless GET as invalid JSON.
//
// Scoped to the TOKEN'S workspace on top of RLS, like /known and /runs: RLS
// alone spans every workspace the owner belongs to, and here that would not just
// leak another tenant's company names, it would hand an agent run-ready ids for
// them.

export async function GET(req: Request) {
  const a = await authorize(req);
  if (!a.ok) return a.response;
  const { auth } = a;

  const url = new URL(req.url);
  const { limit, offset } = pageParams(
    url.searchParams.get("limit"),
    url.searchParams.get("offset"),
  );

  try {
    const page = await withRls(auth.ownerId, (db) =>
      listTargets(asSupabase(db), auth.workspaceId, { limit, offset }),
    );
    return NextResponse.json(page);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not load target companies" },
      { status: 500 },
    );
  }
}
