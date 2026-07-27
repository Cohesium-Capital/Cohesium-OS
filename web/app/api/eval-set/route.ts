import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentWorkspaceId } from "@/lib/workspace/context";

// JSONL eval set: every graded correction pair (a field a grader marked wrong or
// missing, with the corrected value). This is the regression set used to compare
// prompt versions — feed it back to a future runner/eval harness. Authenticated
// by the user session (a founder hits this from the app). Optional ?module= to
// scope to one stage.

type GradeRow = {
  contact_id: string;
  module: string;
  field: string;
  verdict: string;
  correction: string | null;
  previous_value: string | null;
  error_category: string | null;
  run_id: string | null;
  created_at: string;
};

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const moduleParam = new URL(req.url).searchParams.get("module");
  // Grades carry no workspace_id (child of contacts); scope through the join
  // so the eval set never blends correction pairs — real contact data — from
  // another workspace this user happens to belong to.
  const workspaceId = await currentWorkspaceId();

  let query = supabase
    .from("grades")
    .select(
      "contact_id, module, field, verdict, correction, previous_value, error_category, run_id, created_at, contacts!inner(workspace_id)",
    )
    .eq("contacts.workspace_id", workspaceId)
    .in("verdict", ["wrong", "missing"])
    .order("created_at", { ascending: true });
  if (moduleParam) query = query.eq("module", moduleParam);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as GradeRow[];
  const lines = rows.map((r) =>
    JSON.stringify({
      module: r.module,
      field: r.field,
      verdict: r.verdict,
      input: r.previous_value,
      expected: r.correction,
      error_category: r.error_category,
      contact_id: r.contact_id,
      run_id: r.run_id,
      graded_at: r.created_at,
    }),
  );

  const suffix = moduleParam ? `-${moduleParam}` : "";
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="eval-set${suffix}.jsonl"`,
    },
  });
}
