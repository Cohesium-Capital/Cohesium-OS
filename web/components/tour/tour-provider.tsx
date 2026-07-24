"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { TOUR_STEPS, TOUR_STORAGE_KEY } from "./steps";
import { TourOverlay } from "./tour-overlay";

// Tour engine state. Contract: localStorage["cohesium-tour"] holds JSON
// {active, step}. The provider is mounted once in the (app) layout so the
// overlay survives client navigation, and localStorage makes it survive full
// reloads. Exiting keeps the step so "Resume tour" picks up where you left
// off; the overlay renders only after hydration so SSR markup never differs.

type TourState = { active: boolean; step: number };

type TourContextValue = {
  active: boolean;
  step: number;
  stepCount: number;
  /** Last saved position — lets the Demonstrate dialog offer Resume while inactive. */
  savedStep: number;
  start: (step?: number) => void;
  exit: () => void;
  next: () => void;
  back: () => void;
};

const TourContext = createContext<TourContextValue | null>(null);

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}

function clampStep(step: unknown): number {
  const n = typeof step === "number" && Number.isFinite(step) ? Math.floor(step) : 0;
  return Math.min(Math.max(n, 0), TOUR_STEPS.length - 1);
}

function readStored(): TourState {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return { active: false, step: 0 };
    const parsed = JSON.parse(raw) as Partial<TourState> | null;
    return { active: parsed?.active === true, step: clampStep(parsed?.step) };
  } catch {
    return { active: false, step: 0 };
  }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TourState>({ active: false, step: 0 });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(readStored());
    setHydrated(true);
  }, []);

  // All transitions persist to localStorage in the same tick so a reload
  // mid-tour lands on the same step.
  const apply = useCallback((fn: (prev: TourState) => TourState) => {
    setState((prev) => {
      const next = fn(prev);
      try {
        localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the tour still works for this page load.
      }
      return next;
    });
  }, []);

  const start = useCallback(
    (step?: number) =>
      apply((prev) => ({ active: true, step: clampStep(step ?? prev.step) })),
    [apply],
  );
  const exit = useCallback(() => apply((prev) => ({ ...prev, active: false })), [apply]);
  const next = useCallback(
    () => apply((prev) => ({ active: true, step: clampStep(prev.step + 1) })),
    [apply],
  );
  const back = useCallback(
    () => apply((prev) => ({ active: true, step: clampStep(prev.step - 1) })),
    [apply],
  );

  const value = useMemo<TourContextValue>(
    () => ({
      active: state.active,
      step: state.step,
      stepCount: TOUR_STEPS.length,
      savedStep: state.step,
      start,
      exit,
      next,
      back,
    }),
    [state.active, state.step, start, exit, next, back],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      {hydrated && state.active && <TourOverlay />}
    </TourContext.Provider>
  );
}
