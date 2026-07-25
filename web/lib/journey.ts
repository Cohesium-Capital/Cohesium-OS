import type { SupabaseClient } from "@supabase/supabase-js";
import { hookCoverage } from "./hooks/usable";

// The next-best-action engine: given the pipeline's current state, answer
// "what should I do right now?" with a single action. Used by the home page
// hero so a returning user gets one obvious click instead of scanning stage
// counts. Inbound work (untriaged replies, pending suppressions) always wins;
// after that, priority walks the pipeline in workflow order — the earliest
// stage with work waiting wins, because upstream stages gate everything
// downstream.

export type NextAction = {
  href: string;
  cta: string;
  headline: string;
  detail: string;
  step: number | null; // pipeline step number, for the badge
};

/**
 * Draft eligibility, shared by the journey engine and the home-page tiles so
 * the hero and the map read the same number: has an address, sourcing gate
 * passed (or legacy batch-less), no active/pending suppression, and no live
 * planned outbound touch — a drafted contact belongs to the send queue until
 * its draft sends or is soft-deleted back to drafting.
 */
export async function draftEligibleContactIds(supabase: SupabaseClient): Promise<Set<string>> {
  const [{ data: withAddress }, { data: planned }, { data: sup }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, batch_id, batches(gate_status)")
      .or("email.not.is.null,linkedin_url.not.is.null")
      .is("deleted_at", null),
    supabase
      .from("touches")
      .select("contact_id")
      .eq("status", "planned")
      .eq("direction", "outbound")
      .is("deleted_at", null),
    supabase
      .from("suppressions")
      .select("contact_id")
      .in("status", ["active", "pending"]),
  ]);
  const plannedContacts = new Set((planned ?? []).map((t) => t.contact_id));
  const suppressed = new Set((sup ?? []).map((s) => s.contact_id));
  return new Set(
    (
      (withAddress ?? []) as unknown as {
        id: string;
        batch_id: string | null;
        batches: { gate_status: string } | null;
      }[]
    )
      .filter(
        (r) =>
          (!r.batch_id || r.batches?.gate_status === "passed") &&
          !plannedContacts.has(r.id) &&
          !suppressed.has(r.id),
      )
      .map((r) => r.id),
  );
}

export async function countDraftable(supabase: SupabaseClient): Promise<number> {
  return (await draftEligibleContactIds(supabase)).size;
}

/**
 * Contacts still needing hook research: draft-eligible minus contacts holding
 * a USABLE hook and minus contacts with a candidate hook still in flight
 * (sampled awaiting a verdict, or riding an undecided gate) — re-researching
 * those would duplicate work. Both sets come from the canonical definition in
 * lib/hooks/usable.ts, the same one drafting and the Personalize workspace
 * consume, so the hero, the home tile, and the workspace read one number.
 */
export async function contactsNeedingHookIds(supabase: SupabaseClient): Promise<Set<string>> {
  const eligible = await draftEligibleContactIds(supabase);
  if (eligible.size === 0) return eligible;

  const { usable, pending } = await hookCoverage(supabase);
  return new Set([...eligible].filter((id) => !usable.has(id) && !pending.has(id)));
}

export async function countNeedingHooks(supabase: SupabaseClient): Promise<number> {
  return (await contactsNeedingHookIds(supabase)).size;
}

export async function getNextAction(supabase: SupabaseClient): Promise<NextAction> {
  const [
    untriaged,
    pendingSuppressions,
    contactsTotal,
    unreviewed,
    awaitingGrade,
    pendingEnrich,
    hooksToVerify,
    queued,
  ] = await Promise.all([
    supabase
      .from("interactions")
      .select("id, contacts!inner(id)", { count: "exact", head: true })
      .is("disposition", null)
      .is("contacts.deleted_at", null),
    supabase
      .from("suppressions")
      .select("id, contacts!inner(id)", { count: "exact", head: true })
      .eq("status", "pending")
      .is("contacts.deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("reviewed", false)
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("sampled", true)
      .eq("review_status", "pending_review")
      .not("batch_id", "is", null)
      .is("deleted_at", null),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("enrichment_status", "pending")
      .is("deleted_at", null),
    supabase
      .from("hooks")
      .select("id, contacts!inner(id)", { count: "exact", head: true })
      .eq("sampled", true)
      .eq("status", "candidate")
      .is("contacts.deleted_at", null),
    supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("status", "planned")
      .eq("direction", "outbound")
      .is("deleted_at", null),
  ]);

  // 0a. Untriaged replies outrank everything: each one is a human answering us,
  //     and an unhonored opt-out hiding in the pile makes every send unsafe.
  if ((untriaged.count ?? 0) > 0) {
    const n = untriaged.count!;
    return {
      href: "/triage",
      cta: "Triage replies",
      headline: `${n} repl${n === 1 ? "y" : "ies"} to triage`,
      detail:
        "Read each reply verbatim and give it a disposition — one keystroke each. Opt-outs become suppressions the moment you mark them.",
      step: 7,
    };
  }

  // 0b. Pending suppressions block sends for those contacts until a human
  //     confirms or revokes the auto-matcher's guess.
  if ((pendingSuppressions.count ?? 0) > 0) {
    const n = pendingSuppressions.count!;
    return {
      href: "/triage",
      cta: "Confirm suppressions",
      headline: `${n} suppression${n === 1 ? "" : "s"} awaiting confirmation`,
      detail: `The auto-matcher flagged ${n} possible opt-out${n === 1 ? "" : "s"}. Sends to those contacts stay blocked until you confirm or revoke each one on Triage.`,
      step: 7,
    };
  }

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
      step: 2,
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
      step: 3,
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
      step: 3,
    };
  }

  // 5. Hook verification: sampled hooks are what let a personalization batch
  //    clear its gate, so pending verifications hold every unsampled candidate
  //    in that batch back from drafting.
  if ((hooksToVerify.count ?? 0) > 0) {
    const n = hooksToVerify.count!;
    return {
      href: "/personalize",
      cta: "Verify hooks",
      headline: `${n} hook${n === 1 ? "" : "s"} awaiting verification`,
      detail:
        "Open each sampled hook's source URL and check two things: the page supports this exact claim, and the claim is specific to this person or company. Verifying the sample is what lets the personalization batch clear its gate.",
      step: 4,
    };
  }

  // 6. Hook research. Deliberately outranks drafting in the walk, but drafting
  //    stays open regardless — the no-hook arm is the rent check's control
  //    group, so a missing hook must never block a draft.
  const needingHooks = await countNeedingHooks(supabase);
  if (needingHooks > 0) {
    return {
      href: "/personalize",
      cta: "Research hooks",
      headline: `${needingHooks} contact${needingHooks === 1 ? "" : "s"} need${needingHooks === 1 ? "s" : ""} hooks`,
      detail:
        "Draft is waiting on these: research one verifiable hook per contact — or record an honest no-hook with a fallback angle. Either way drafting stays pure writing, no web research at draft time.",
      step: 4,
    };
  }

  // 7. Drafting — eligibility shared with the home page tiles via
  //    countDraftable so the hero and the map can never drift apart.
  const draftable = await countDraftable(supabase);
  if (draftable > 0) {
    return {
      href: "/draft",
      cta: "Draft messages",
      headline: `${draftable} contact${draftable === 1 ? "" : "s"} ready to draft`,
      detail:
        "Their batches passed the gate and they have an address. Copy the drafting prompt, run it, and paste the JSON back.",
      step: 5,
    };
  }

  // 8. Send queue.
  if ((queued.count ?? 0) > 0) {
    const n = queued.count!;
    return {
      href: "/draft/queue",
      cta: "Open send queue",
      headline: `${n} message${n === 1 ? "" : "s"} queued for review`,
      detail:
        "Read each draft and approve it — only approved messages send. Edits are logged as quality signals.",
      step: 6,
    };
  }

  // 9. Nothing in flight: source more, and point at the scoreboard.
  return {
    href: "/source",
    cta: "Start a new run",
    headline: "Pipeline is clear",
    detail:
      "Nothing is waiting at any stage. Start a new sourcing run — or check Outcomes to see how past prompts performed.",
    step: 1,
  };
}
