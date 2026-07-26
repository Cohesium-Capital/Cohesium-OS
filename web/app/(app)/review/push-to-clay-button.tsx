"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { pushPendingToClay } from "@/lib/sourcing/review-actions";
import { Button } from "@/components/ui/button";
import { useReviewSelection } from "./review-grid";

// Pushes eligible contacts to the Clay table webhook (programmatic alternative
// to the CSV export). Two explicit affordances so scope is never ambiguous:
// the primary pushes the grid's selection when one exists (otherwise the whole
// eligible set), and a secondary "Push all N eligible" stays reachable while a
// selection is active — the grid defaults to selecting the current page, which
// must never silently stand in for "all eligible". Server-side eligibility
// (reviewed, not deleted, gate-passed batch) intersects either way, so the
// count actually pushed can be smaller than the selection. On success the grid
// selection is cleared and the page refreshed so the eligible count and
// selection reflect the new state.
//
// Contacts already sent to Clay are excluded from every push by default — they
// have already cost credits. Re-sending them is a separate, armed action
// (click, then confirm) so it can never happen as a side effect of pressing
// "push all".
export function PushToClayButton({
  eligibleCount,
  alreadySentCount = 0,
}: {
  eligibleCount: number;
  alreadySentCount?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resendArmed, setResendArmed] = useState(false);
  const { selectedIds, requestClear } = useReviewSelection();

  // An empty ids array means "all eligible" (see pushPendingToClay).
  function push(ids: string[], resend = false) {
    startTransition(async () => {
      try {
        const { total, pushed, failed, error } = await pushPendingToClay(ids, resend);
        if (total === 0) {
          toast.info(
            ids.length
              ? "None of the selected rows are eligible (reviewed + gate-passed)."
              : "Nothing eligible to push.",
          );
        } else if (failed === 0 && !error) {
          toast.success(`Pushed ${pushed} to Clay.`);
        } else if (failed === 0) {
          toast.warning(`Pushed ${pushed} to Clay, but: ${error}`);
        } else {
          toast.warning(
            `Pushed ${pushed} to Clay, ${failed} failed${error ? ` (${error})` : ""}.`,
          );
        }
        if (pushed > 0) requestClear();
        setResendArmed(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Push failed.");
      }
    });
  }

  const hasSelection = selectedIds.length > 0;
  const label = hasSelection
    ? `Push ${selectedIds.length} selected to Clay`
    : `Push all ${eligibleCount} eligible`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        disabled={pending || (!hasSelection && eligibleCount === 0)}
        onClick={() => push(hasSelection ? selectedIds : [])}
      >
        {pending ? "Pushing…" : label}
      </Button>
      {hasSelection && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || eligibleCount === 0}
          onClick={() => push([])}
        >
          Push all {eligibleCount} eligible
        </Button>
      )}
      {alreadySentCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => (resendArmed ? push([], true) : setResendArmed(true))}
        >
          {resendArmed
            ? `Confirm: re-send ${alreadySentCount} and spend credits again`
            : `Re-send ${alreadySentCount} already sent…`}
        </Button>
      )}
    </div>
  );
}
