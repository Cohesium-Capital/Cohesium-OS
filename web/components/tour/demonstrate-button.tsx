"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { demoTourStatus, seedDemoTour, wipeDemoTour } from "@/lib/demo/actions";
import { useTour } from "./tour-provider";

// Entry point for Demonstrate mode. First click: explain what gets seeded and
// confirm before writing anything. If demo data already exists (idempotent
// marker org), offer Resume / Restart / Clean up instead — the tour position
// itself lives in localStorage via the TourProvider.

export function DemonstrateButton() {
  const router = useRouter();
  const { start, savedStep, stepCount } = useTour();
  const [open, setOpen] = useState(false);
  const [seeded, setSeeded] = useState<boolean | null>(null); // null = checking
  const [pending, startTransition] = useTransition();

  function openDialog() {
    setOpen(true);
    setSeeded(null);
    startTransition(async () => {
      try {
        // Shape-tolerant read of the shared contract: demoTourStatus() reports
        // whether the marker org (hq.walkthrough.example) is present.
        const status = (await demoTourStatus()) as unknown as { seeded?: boolean } | null;
        setSeeded(status?.seeded === true);
      } catch {
        // Status check failed — assume fresh; seeding is idempotent anyway.
        setSeeded(false);
      }
    });
  }

  function beginTour(atStep: number) {
    setOpen(false);
    router.refresh(); // seeded rows should show up under the spotlight
    start(atStep);
  }

  function seedAndStart() {
    startTransition(async () => {
      try {
        await seedDemoTour();
        toast.success("Demo data seeded — every row is clearly fake and one click removes it.");
        beginTour(0);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Seeding demo data failed.");
      }
    });
  }

  function restart() {
    startTransition(async () => {
      try {
        // Fresh rows so the try-it steps (grading, verifying, triage) work
        // again instead of finding already-judged records.
        await wipeDemoTour();
        await seedDemoTour();
        toast.success("Demo data reset.");
        beginTour(0);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Restarting the demo failed.");
      }
    });
  }

  function cleanUp() {
    startTransition(async () => {
      try {
        await wipeDemoTour();
        toast.success("Demo data cleaned up.");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Cleanup failed.");
      }
    });
  }

  return (
    <div data-tour="demonstrate">
      <Button variant="outline" onClick={openDialog}>
        <Sparkles className="size-4" />
        Demonstrate
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {seeded ? (
            <>
              <DialogHeader>
                <DialogTitle>Demo data already seeded</DialogTitle>
                <DialogDescription>
                  The walkthrough rows are still in place. Resume from step {savedStep + 1} of{" "}
                  {stepCount}, restart with fresh rows, or clean everything up.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={cleanUp} disabled={pending}>
                  Clean up
                </Button>
                <Button variant="outline" onClick={restart} disabled={pending}>
                  Restart
                </Button>
                <Button onClick={() => beginTour(savedStep)} disabled={pending}>
                  <Play className="size-4" />
                  Resume tour
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Walk the pipeline on demo data</DialogTitle>
                <DialogDescription>
                  This seeds a small, clearly-fake dataset — every org lives on a
                  .walkthrough.example domain and every contact email ends in .example, so
                  nothing can enrich or send for real. The tour then walks you through the
                  actual UI end to end: you grade, verify hooks, edit a draft, and triage
                  replies yourself. One-click cleanup at the end removes every demo row.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter showCloseButton>
                <Button onClick={seedAndStart} disabled={pending || seeded === null}>
                  <Play className="size-4" />
                  {pending ? "Seeding…" : "Seed demo data & start"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
