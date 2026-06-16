"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { pushPendingToClay } from "@/lib/sourcing/review-actions";
import { Button } from "@/components/ui/button";

// Pushes pending contacts to the Clay table webhook (programmatic alternative to
// the CSV export). Toasts the result counts and refreshes so the grid reflects
// the new "enriching" status.
export function PushToClayButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function push() {
    startTransition(async () => {
      try {
        const { total, pushed, failed } = await pushPendingToClay();
        if (total === 0) {
          toast.info("Nothing pending to push.");
        } else if (failed === 0) {
          toast.success(`Pushed ${pushed} to Clay.`);
        } else {
          toast.warning(`Pushed ${pushed} to Clay, ${failed} failed.`);
        }
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Push failed.");
      }
    });
  }

  return (
    <Button variant="outline" disabled={pending} onClick={push}>
      {pending ? "Pushing…" : "Push pending to Clay"}
    </Button>
  );
}
