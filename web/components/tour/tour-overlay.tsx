"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { wipeDemoTour } from "@/lib/demo/actions";
import { TOUR_STEPS } from "./steps";
import { useTour } from "./tour-provider";

// Hand-rolled spotlight (no dependency): four fixed dim panels around the
// target's rect block clicks OUTSIDE the cutout, while the cutout itself is
// simply the gap between them — so on "try it" steps the user really clicks
// and types in the highlighted region. A pointer-events-none ring draws the
// highlight. If the step's route differs from the current pathname we push
// and wait; if the anchor never shows up (~2s of polling) we fall back to a
// centered card rather than stranding the tour.

const SPOT_PAD = 8; // px of breathing room around the target rect
const CARD_W = 384; // matches w-96
const EDGE = 16; // min gap from viewport edges
const POLL_MS = 100;
const POLL_TRIES = 20; // ~2s

type Rect = { top: number; left: number; width: number; height: number };

function sameRect(a: Rect | null, b: Rect) {
  return (
    !!a &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

export function TourOverlay() {
  const { step, stepCount, next, back, exit } = useTour();
  const def = TOUR_STEPS[step];
  const pathname = usePathname();
  const router = useRouter();
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [wiping, startWipe] = useTransition();
  const elRef = useRef<HTMLElement | null>(null);

  const onRoute = pathname === def.route;
  const isLast = step === stepCount - 1;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Steer to the step's route. usePathname updates once the push lands, which
  // re-runs this effect into the matched (no-op) branch — no loop, no flag.
  useEffect(() => {
    if (!onRoute) router.push(def.route);
  }, [onRoute, def.route, router]);

  // Find the anchor: poll up to ~2s once we're on the right route, then fall
  // back to a centered card. Targetless steps go centered immediately.
  useEffect(() => {
    elRef.current = null;
    setRect(null);
    setMissing(false);
    if (!def.target) {
      setMissing(true);
      return;
    }
    if (!onRoute) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${def.target}"]`);
      if (el) {
        elRef.current = el;
        el.scrollIntoView({ block: "center", behavior });
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else if (++tries >= POLL_TRIES) {
        setMissing(true);
      } else {
        timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // reducedMotion intentionally omitted: it only picks scroll behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, onRoute, def.target]);

  // Track the rect on resize/scroll (rAF-throttled) plus a slow interval to
  // catch layout shifts from data loading. If the element left the DOM (e.g.
  // a queue emptied and the card unmounted), re-query; if it's truly gone,
  // fall back to the centered card instead of spotlighting a stale spot.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let el = elRef.current;
      if (el && !el.isConnected) {
        el = def.target
          ? document.querySelector<HTMLElement>(`[data-tour="${def.target}"]`)
          : null;
        elRef.current = el;
        if (!el) {
          setRect(null);
          setMissing(true);
          return;
        }
      }
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nextRect = { top: r.top, left: r.left, width: r.width, height: r.height };
      setRect((prev) => (sameRect(prev, nextRect) ? prev : nextRect));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const interval = setInterval(schedule, 500);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      clearInterval(interval);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [def.target]);

  const finishAndWipe = useCallback(() => {
    startWipe(async () => {
      try {
        await wipeDemoTour();
        toast.success("Demo data cleaned up. The pipeline is yours.");
        exit();
        router.push("/");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Cleanup failed — try again from the Demonstrate dialog.");
      }
    });
  }, [exit, router]);

  // Keyboard: arrows step, Escape exits. Same guard as the grade/verify
  // queues — never fire from inputs/textareas/contenteditable, ignore chords.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // defaultPrevented: an open dialog's own Escape handling wins — closing
      // a modal mid-step must not also exit the tour.
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (e.key === "ArrowRight" && !isLast) next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") exit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, exit, isLast]);

  const noMotion = reducedMotion ? "transition-none" : "transition-all duration-200";
  const spotlight = rect && !missing;

  // Card placement: below the target when there's room, otherwise above;
  // clamped to the viewport horizontally. Centered when there's no target.
  let cardStyle: React.CSSProperties;
  if (spotlight && rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(rect.left, EDGE), Math.max(vw - CARD_W - EDGE, EDGE));
    const roomBelow = vh - (rect.top + rect.height + SPOT_PAD) >= 280;
    cardStyle = roomBelow
      ? { left, top: rect.top + rect.height + SPOT_PAD + 12 }
      : { left, bottom: vh - rect.top + SPOT_PAD + 12 };
  } else {
    cardStyle = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  }

  const dim = "fixed bg-black/50";

  return (
    <>
      {/* Backdrop: four panels around the cutout (clicks pass through inside
          it), or one full panel while polling / for centered steps. */}
      {spotlight && rect ? (
        <>
          <div
            className={cn(dim, noMotion, "inset-x-0 top-0 z-[90]")}
            style={{ height: Math.max(rect.top - SPOT_PAD, 0) }}
          />
          <div
            className={cn(dim, noMotion, "inset-x-0 bottom-0 z-[90]")}
            style={{ top: rect.top + rect.height + SPOT_PAD }}
          />
          <div
            className={cn(dim, noMotion, "left-0 z-[90]")}
            style={{
              top: Math.max(rect.top - SPOT_PAD, 0),
              height: rect.height + SPOT_PAD * 2,
              width: Math.max(rect.left - SPOT_PAD, 0),
            }}
          />
          <div
            className={cn(dim, noMotion, "right-0 z-[90]")}
            style={{
              top: Math.max(rect.top - SPOT_PAD, 0),
              height: rect.height + SPOT_PAD * 2,
              left: rect.left + rect.width + SPOT_PAD,
            }}
          />
          <div
            aria-hidden
            className={cn(
              "pointer-events-none fixed z-[91] rounded-xl ring-2 ring-primary shadow-elev-2",
              noMotion,
            )}
            style={{
              top: rect.top - SPOT_PAD,
              left: rect.left - SPOT_PAD,
              width: rect.width + SPOT_PAD * 2,
              height: rect.height + SPOT_PAD * 2,
            }}
          />
        </>
      ) : (
        <div className={cn(dim, "inset-0 z-[90]")} />
      )}

      {/* Slim persistent banner so the mode is never ambiguous. */}
      <div className="fixed top-3 left-1/2 z-[96] -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-full border border-border/60 bg-popover px-3 py-1 text-xs text-popover-foreground shadow-elev-2">
          <Sparkles className="size-3 text-primary" />
          <span className="font-medium">Demo walkthrough</span>
          <span className="text-muted-foreground tabular-nums">
            step {step + 1}/{stepCount}
          </span>
          <button
            type="button"
            onClick={exit}
            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" /> Exit
          </button>
        </div>
      </div>

      {/* Step card: near the target, centered when there is none (or it never
          appeared). Hidden while polling so it can't point at nothing. */}
      {(spotlight || missing) && (
        <div className="fixed z-[95]" style={cardStyle}>
          <Card className="w-96 max-w-[calc(100vw-2rem)] gap-3 px-5 py-4 shadow-elev-2">
            <div className="flex items-center justify-between">
              <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70 tabular-nums">
                Step {step + 1} of {stepCount}
              </span>
              {def.kind === "try" && <Badge variant="secondary">Try it</Badge>}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="font-medium">{def.title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{def.body}</p>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={exit}>
                Exit tour
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={back} disabled={step === 0}>
                  <ArrowLeft className="size-3.5" /> Back
                </Button>
                {def.kind === "finish" ? (
                  <Button size="sm" onClick={finishAndWipe} disabled={wiping}>
                    {wiping ? "Cleaning up…" : "Finish & clean up demo data"}
                  </Button>
                ) : (
                  <Button size="sm" onClick={next}>
                    Next <ArrowRight className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
            {def.kind === "finish" && (
              <p className="text-[0.68rem] text-muted-foreground">
                Cleanup deletes every .walkthrough.example org and demo-tour batch. Or exit
                and clean up later from the Demonstrate dialog.
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
