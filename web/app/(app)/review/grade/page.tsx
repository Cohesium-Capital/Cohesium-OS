import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { computeGate } from "@/lib/grading/gate";
import { Button } from "@/components/ui/button";
import { GradeQueue, type GradeContact } from "./grade-queue";

// Keyboard-driven grading queue. Grades the sampled, not-yet-graded contacts of
// one batch; the batch gate flips to passed/failed as the sample fills in. A
// batch can't advance (enrich/draft/send) until it passes.

type ContactRow = {
  id: string;
  batch_id: string | null;
  full_name: string | null;
  title: string | null;
  persona: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  personalization: string | null;
  confidence: string | null;
  source_url: string | null;
  evidence: unknown;
  organizations: { name: string; domain: string | null } | null;
};

export default async function GradePage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  // Pick the batch to grade: explicit ?batch= or the oldest with pending sample.
  let batchId = sp.batch ?? null;
  if (!batchId) {
    const { data: next } = await supabase
      .from("contacts")
      .select("batch_id")
      .eq("sampled", true)
      .eq("review_status", "pending_review")
      .not("batch_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    batchId = (next?.batch_id as string | null) ?? null;
  }

  if (!batchId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Grade</h1>
        <p className="text-sm text-muted-foreground">
          Nothing to grade — no batch has sampled contacts awaiting review.
        </p>
        <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
          Back to runs
        </Button>
      </div>
    );
  }

  const { data: batch } = await supabase
    .from("batches")
    .select("id, module, label, gate_status")
    .eq("id", batchId)
    .single();

  const { data, count } = await supabase
    .from("contacts")
    .select(
      "id, batch_id, full_name, title, persona, email, phone, linkedin_url, personalization, confidence, source_url, evidence, organizations!inner(name, domain)",
      { count: "exact" },
    )
    .eq("batch_id", batchId)
    .eq("sampled", true)
    .eq("review_status", "pending_review")
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as unknown as ContactRow[];
  const contacts: GradeContact[] = rows.map((c) => ({
    id: c.id,
    batch_id: c.batch_id,
    full_name: c.full_name,
    title: c.title,
    persona: c.persona,
    email: c.email,
    phone: c.phone,
    linkedin_url: c.linkedin_url,
    personalization: c.personalization,
    confidence: c.confidence,
    source_url: c.source_url,
    evidence: Array.isArray(c.evidence)
      ? (c.evidence as { url: string; via?: string }[])
      : [],
    org_name: c.organizations?.name ?? "—",
    org_domain: c.organizations?.domain ?? null,
  }));

  const metrics = await computeGate(supabase, batchId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Grade</h1>
          <p className="text-sm text-muted-foreground">
            Batch <span className="font-medium">{batch?.label}</span> · {batch?.module} ·{" "}
            {count ?? 0} awaiting grade
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
          All runs
        </Button>
      </div>
      <GradeQueue
        module={batch?.module ?? "sourcing"}
        batchId={batchId}
        initialMetrics={metrics}
        contacts={contacts}
      />
    </div>
  );
}
