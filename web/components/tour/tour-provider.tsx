"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
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

const SERVER_STATE: TourState = { active: false, step: 0 };

// Snapshot cache: useSyncExternalStore demands a referentially stable value
// while the underlying storage is unchanged, or it re-renders forever.
let cachedRaw: string | null = null;
let cachedState: TourState = SERVER_STATE;
const listeners = new Set<() => void>();

function emitTourChange() {
  listeners.forEach((l) => l());
}

function subscribeTour(onChange: () => void) {
  listeners.add(onChange);
  // A second tab moving the tour keeps this one in step.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getTourSnapshot(): TourState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TOUR_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedState = readStored();
  }
  return cachedState;
}

function getTourServerSnapshot(): TourState {
  return SERVER_STATE;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  // localStorage IS the tour's state, so it's read as an external store rather
  // than copied into React state by a post-mount effect. The server snapshot is
  // the inactive default, which is also what SSR renders — React swaps in the
  // stored position after hydration, so markup never mismatches.
  const state = useSyncExternalStore(subscribeTour, getTourSnapshot, getTourServerSnapshot);

  // All transitions persist to localStorage in the same tick so a reload
  // mid-tour lands on the same step.
  const apply = useCallback((fn: (prev: TourState) => TourState) => {
    const next = fn(getTourSnapshot());
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: hold the position in memory so the tour still
      // works for this page load.
      cachedRaw = null;
      cachedState = next;
    }
    emitTourChange();
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
      {state.active && <TourOverlay />}
    </TourContext.Provider>
  );
}
