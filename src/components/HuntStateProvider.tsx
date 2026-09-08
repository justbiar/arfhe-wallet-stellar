/**
 * HuntStateProvider — lets a screen say what is true of it right now.
 *
 * Some hiding places are not screens but moments: a token has just been shielded, a
 * connection has just been revoked, ten messages have gone to the agent. The surface that
 * draws the marks cannot know any of that by looking at the route.
 *
 * It could reach into each screen and check — but that would put a piece of the hunt back
 * into all thirteen of them, which is the arrangement this whole design exists to undo. So
 * screens push a plain string up instead, and the meaning of that string lives on the
 * server. A screen declaring `has-shielded` does not know whether anything hides there.
 *
 * None of this is a security boundary. Anyone who reads the bundle can send any state they
 * like straight to the server. That is fine: these decide whether a mark is *drawn*, and the
 * word behind it is still gated on something the server verifies against the chain.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

interface HuntStateApi {
  states: string[];
  /** Declare a state true for as long as the calling screen wants it. */
  setState: (key: string, active: boolean) => void;
  /** Declare something that just happened. Clears itself, so it cannot linger into another screen. */
  pulse: (key: string, ms?: number) => void;
}

type HuntActions = Omit<HuntStateApi, "states">;

const NO_ACTIONS: HuntActions = { setState: () => {}, pulse: () => {} };

/**
 * Split in two on purpose.
 *
 * The states change constantly; the two functions never do. Handing both out through one
 * context meant every screen that only wanted to *declare* a state re-rendered whenever any
 * other screen changed one — and, worse, the hook that read them built a fresh object each
 * time. A screen putting that object in a `useEffect` dependency list got an effect that
 * re-ran on every render, and since these effects set state, that is a loop with no exit:
 * cleanup writes false, the effect writes true, the provider re-renders, the object is new
 * again. React reports nothing, because nothing threw — the wallet simply stopped
 * responding, which is exactly how it looked.
 *
 * Actions live in their own context so their identity is stable for the life of the
 * provider, and `useHuntState()` can be depended on safely.
 */
const HuntStatesContext = createContext<string[]>([]);
const HuntActionsContext = createContext<HuntActions>(NO_ACTIONS);

/** How long a "this just happened" state stays true. Long enough to notice a mark appear. */
const PULSE_MS = 20_000;

export function HuntStateProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<string[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const setState = useCallback((key: string, active: boolean) => {
    setStates((current) => {
      const has = current.includes(key);
      if (active === has) return current; // no re-render for a no-op
      return active ? [...current, key] : current.filter((s) => s !== key);
    });
  }, []);

  const pulse = useCallback((key: string, ms: number = PULSE_MS) => {
    setState(key, true);
    const existing = timers.current.get(key);
    if (existing) window.clearTimeout(existing);
    timers.current.set(key, window.setTimeout(() => {
      setState(key, false);
      timers.current.delete(key);
    }, ms));
  }, [setState]);

  // Depends only on the two callbacks, both of which are stable, so this object is created
  // once and keeps its identity for the life of the provider.
  const actions = useMemo<HuntActions>(() => ({ setState, pulse }), [setState, pulse]);

  return (
    <HuntActionsContext.Provider value={actions}>
      <HuntStatesContext.Provider value={states}>{children}</HuntStatesContext.Provider>
    </HuntActionsContext.Provider>
  );
}

/** Read the current states. Used by HuntSurface. */
export function useHuntStates(): string[] {
  return useContext(HuntStatesContext);
}

/**
 * Declare states from a screen. Safe to call when the hunt is off — nothing is sent.
 *
 * The returned object is stable, so it is safe in a dependency array. Screens do put it in
 * one, and when it was rebuilt on every render that turned every such effect into an
 * infinite loop.
 */
export function useHuntState(): HuntActions {
  return useContext(HuntActionsContext);
}
