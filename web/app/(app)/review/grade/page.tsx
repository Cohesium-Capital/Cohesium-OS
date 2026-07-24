import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { computeGate, type GateMetrics } from "@/lib/grading/gate";
import { Button } from "@/components/ui/button";
import { GradeQueue, type GradeContact } from "./grade-queue";

// Keyboard-driven grading queue. By default it loads EVERY sampled, not-yet-graded
// contact across all batches into one continuous pass, so you can grade the whole
// backlog in one sitting; each grade still finalizes against its own batch and
// flips that batch's gate. Pass ?batch=<id> to grade a single batch in isolation
// (the per-row "Grade" buttons on /runs use this). A batch can't advance
// (enrich/draft/send) until it passes.

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
  batches: { module: string; label: string } | null;
};

export default async function GradePage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string }>;
}) {
  const sp = await searchParams;
  const batchId = sp.batch ?? null;
  const supabase = await createClient();

  // All sampled contacts still awaiting a grade — across every batch, or scoped
  // to one when ?batch= is given. Ordered by batch so same-module records (and
  // the editable fields they share) stay contiguous as you advance.
  let query = supabase
    .from("contacts")
    .select(
      "id, batch_id, full_name, title, persona, email, phone, linkedin_url, personalization, confidence, source_url, evidence, organizations!inner(name, domain), batches!inner(module, label)",
      { count: "exact" },
    )
    .eq("sampled", true)
    .eq("review_status", "pending_review");
  if (batchId) query = query.eq("batch_id", batchId);
  const { data, count } = await query
    .order("batch_id", { ascending: true })
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as unknown as ContactRow[];

  if (!rows.length) {
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

  const contacts: GradeContact[] = rows.map((c) => ({
    id: c.id,
    batch_id: c.batch_id,
    module: c.batches?.module ?? "sourcing",
    batch_label: c.batches?.label ?? "—",
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

  // One gate per distinct batch in the queue, computed once up front; the queue
  // updates the relevant entry as each contact is graded.
  const batchIds = [...new Set(contacts.map((c) => c.batch_id).filter(Boolean))] as string[];
  const computed = await Promise.all(batchIds.map((id) => computeGate(supabase, id)));
  const metricsByBatch: Record<string, GateMetrics> = {};
  batchIds.forEach((id, i) => (metricsByBatch[id] = computed[i]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Grade</h1>
          <p className="text-sm text-muted-foreground">
            {count ?? contacts.length} awaiting grade across {batchIds.length} batch
            {batchIds.length === 1 ? "" : "es"}
            {batchId ? " (single batch)" : ""}.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
          All runs
        </Button>
      </div>
      <GradeQueue contacts={contacts} initialMetricsByBatch={metricsByBatch} />
    </div>
  );
}
