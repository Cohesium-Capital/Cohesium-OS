import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PushToClayButton } from "./push-to-clay-button";

// Enrich (step 4): the Clay layer as a first-class pipeline stage. Contacts
// arrive from sourcing without an email; this page sends the pending ones to
// Clay and shows the round-trip: pending → (Clay waterfall) → enriched/failed.
// Rows stay "pending" until Clay's write-back lands, so re-sending is safe —
// it only retries the stragglers.

export default async function EnrichPage() {
  const supabase = await createClient();

  const [pending, pendingPassed, enriched, failed, draftable] = await Promise.all([
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "pending"),
    supabase
      .from("contacts")
      .select("id, batches!inner(gate_status)", { count: "exact", head: true })
      .eq("enrichment_status", "pending")
      .eq("batches.gate_status", "passed"),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "enriched"),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .in("enrichment_status", ["failed", "low_confidence"]),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "enriched")
      .or("email.not.is.null,linkedin_url.not.is.null"),
  ]);

  const counts = {
    pending: pending.count ?? 0,
    pendingPassed: pendingPassed.count ?? 0,
    enriched: enriched.count ?? 0,
    failed: failed.count ?? 0,
    draftable: draftable.count ?? 0,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Enrich</h1>
          <p className="text-sm text-muted-foreground">
            Fill in emails and phones via Clay. Contacts can&rsquo;t be drafted until they have an
            address.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/review" />}>
          Back to Review
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <SummaryCard label="Pending" value={counts.pending} accent />
        <SummaryCard label="In gate-passed batches" value={counts.pendingPassed} />
        <SummaryCard label="Enriched" value={counts.enriched} />
        <SummaryCard label="Failed / low-confidence" value={counts.failed} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Send pending contacts to Clay</CardTitle>
          <CardDescription>
            Both actions cover every pending contact. Clay runs its enrichment waterfall and
            writes each finished row back automatically — statuses flip to enriched (or failed)
            here as results land. Re-running is safe: rows stay pending until Clay answers, so
            you only ever retry the stragglers.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {counts.pending === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing pending — every contact has been through enrichment.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <PushToClayButton />
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link href="/api/enrichment/export" prefetch={false} />}
              >
                Export CSV for Clay
              </Button>
              <span className="text-xs text-muted-foreground">
                Push sends rows straight to the Clay table webhook; the CSV is for importing
                manually. Setup lives in docs/CLAY.md.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Forward handoff: where the enriched contacts go next. */}
      <div className="flex flex-col items-start gap-3 rounded-md border p-5">
        {counts.draftable > 0 ? (
          <>
            <p className="text-sm">
              <span className="font-medium">{counts.draftable}</span> enriched contact
              {counts.draftable === 1 ? "" : "s"} now have an address and can be drafted once
              their batch has passed the gate.
            </p>
            <Button nativeButton={false} render={<Link href="/draft" />}>
              Continue to Draft (step 5) →
            </Button>
          </>
        ) : counts.pending > 0 ? (
          <p className="text-sm text-muted-foreground">
            Waiting on Clay — once rows come back enriched, the next step (Draft) unlocks here.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing enriched yet. Source contacts first, then send them through Clay from this
            page.
          </p>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`flex min-w-32 flex-col rounded-lg border px-4 py-3 ${
        accent && value > 0 ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
