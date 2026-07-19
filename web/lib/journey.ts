import type { SupabaseClient } from "@supabase/supabase-js";

// The next-best-action engine: given the pipeline's current state, answer
// "what should I do right now?" with a single action. Used by the home page
// hero so a returning user gets one obvious click instead of scanning stage
// counts. Priority walks the pipeline in workflow order — the earliest stage
// with work waiting wins, because upstream stages gate everything downstream.

export type NextAction = {
  href: string;
  cta: string;
  headline: string;
  detail: string;
  step: number | null; // pipeline step number, for the badge
};

export async function getNextAction(supabase: SupabaseClient): Promise<NextAction> {
  const [contactsTotal, unreviewed, awaitingGrade, pendingEnrich, queued] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("reviewed", false),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("sampled", true)
      .eq("review_status", "pending_review")
      .not("batch_id", "is", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "pending"),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("status", "planned")
      .eq("direction", "outbound"),
  ]);

  // 1. Empty system: start at the top.
  if ((contactsTotal.count ?? 0) === 0) {
    return {
      href: "/source",
      cta: "Start a sourcing run",
      headline: "Start your first sourcing run",
      detail:
        "Pick a mode and region, run the research prompt in Claude or ChatGPT, and import the results. Everything downstream flows from here.",
      step: 1,
    };
  }

  // 2. Grading first: the gate blocks every batch's path to drafting, so
  //    pending grades are always the highest-leverage work.
  if ((awaitingGrade.count ?? 0) > 0) {
    const n = awaitingGrade.count!;
    return {
      href: "/review/grade",
      cta: "Grade now",
      headline: `${n} sampled contact${n === 1 ? "" : "s"} awaiting grade`,
      detail:
        "Grading the sample is what lets a batch clear the eval gate and advance to drafting. Verify each field against its sources.",
      step: 3,
    };
  }

  // 3. Review backlog (vet before enrich).
  if ((unreviewed.count ?? 0) > 0) {
    const n = unreviewed.count!;
    return {
      href: "/review",
      cta: "Review contacts",
      headline: `${n} contact${n === 1 ? "" : "s"} to review`,
      detail:
        "On Review & Enrich: first vet the rows (A), then push keepers to Clay for work emails (B).",
      step: 2,
    };
  }

  // 4. Enrichment backlog — Clay lives on the same Review page (part B).
  if ((pendingEnrich.count ?? 0) > 0) {
    const n = pendingEnrich.count!;
    return {
      href: "/review",
      cta: "Push to Clay",
      headline: `${n} contact${n === 1 ? "" : "s"} waiting on enrichment`,
      detail:
        "Push pending rows to Clay from Review & Enrich (part B). Clay fills work email — the field drafting needs — plus phone and LinkedIn when it can.",
      step: 2,
    };
  }

  // 5. Drafting: mirror the Draft page's eligibility (address + gate passed or
  //    legacy, minus contacts that already have an approved planned touch).
  const [{ data: withAddress }, { data: planned }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, batch_id, batches(gate_status)")
      .or("email.not.is.null,linkedin_url.not.is.null"),
    supabase
      .from("touches")
      .select("contact_id, approved")
      .eq("status", "planned")
      .eq("direction", "outbound"),
  ]);
  const approvedPlanned = new Set(
    (planned ?? []).filter((t) => t.approved).map((t) => t.contact_id),
  );
  const draftable = (
    (withAddress ?? []) as unknown as {
      id: string;
      batch_id: string | null;
      batches: { gate_status: string } | null;
    }[]
  ).filter(
    (r) =>
      (!r.batch_id || r.batches?.gate_status === "passed") && !approvedPlanned.has(r.id),
  ).length;
  if (draftable > 0) {
    return {
      href: "/draft",
      cta: "Draft messages",
      headline: `${draftable} contact${draftable === 1 ? "" : "s"} ready to draft`,
      detail:
        "Their batches passed the gate and they have an address. Copy the drafting prompt, run it, and paste the JSON back.",
      step: 4,
    };
  }

  // 6. Send queue.
  if ((queued.count ?? 0) > 0) {
    const n = queued.count!;
    return {
      href: "/draft/queue",
      cta: "Open send queue",
      headline: `${n} message${n === 1 ? "" : "s"} queued for review`,
      detail:
        "Read each draft, edit anything that's off, then send the approved ones. Edits are logged as quality signals.",
      step: 5,
    };
  }

  // 7. Nothing in flight: source more, and point at the scoreboard.
  return {
    href: "/source",
    cta: "Start a new run",
    headline: "Pipeline is clear",
    detail:
      "Nothing is waiting at any stage. Start a new sourcing run — or check Outcomes to see how past prompts performed.",
    step: 1,
  };
}
