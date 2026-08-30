/**
 * usePersistedState — Session-persistent state hook for Chrome Extension popups.
 *
 * Problem: Chrome extension popups lose ALL React state when closed/reopened.
 * Solution: Persist critical state to chrome.storage.session (or sessionStorage fallback).
 *
 * - chrome.storage.session: survives popup close/open, cleared on browser restart
 * - sessionStorage fallback: for dev mode / non-extension context
 * - Async restore with sync initial value (no flicker)
 * - Debounced writes to avoid storage thrashing
 *
 * Usage:
 *   const [tab, setTab] = usePersistedState("home_tab", 0);
 *   const [hidden, setHidden] = usePersistedState("balance_hidden", false);
 */

import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_PREFIX = "arfhe_ps_";
const DEBOUNCE_MS = 300;

/** Check if chrome.storage.session API is available */
function hasChromeSessionStorage(): boolean {
  try {
    return (
      typeof chrome !== "undefined" &&
      chrome.storage !== undefined &&
      chrome.storage.session !== undefined &&
      typeof chrome.storage.session.get === "function"
    );
  } catch {
    return false;
  }
}

/** Synchronous read from sessionStorage (for initial value) */
function readSync<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (raw !== null) return JSON.parse(raw) as T;
  } catch {
    // parse error or unavailable
  }
  return undefined;
}

/** Async read from chrome.storage.session */
async function readAsync<T>(key: string): Promise<T | undefined> {
  if (hasChromeSessionStorage()) {
    try {
      const storageKey = STORAGE_PREFIX + key;
      const result = await chrome.storage.session.get(storageKey);
      if (result[storageKey] !== undefined) {
        return result[storageKey] as T;
      }
    } catch {
      // fallback below
    }
  }
  return readSync<T>(key);
}

/** Write to both chrome.storage.session and sessionStorage */
async function write<T>(key: string, value: T): Promise<void> {
  const storageKey = STORAGE_PREFIX + key;
  const serialized = JSON.stringify(value);

  // Always write to sessionStorage (sync fallback + dev mode)
  try {
    sessionStorage.setItem(storageKey, serialized);
  } catch {
    // quota exceeded or unavailable
  }

  // Also write to chrome.storage.session if available
  if (hasChromeSessionStorage()) {
    try {
      await chrome.storage.session.set({ [storageKey]: value });
    } catch {
      // extension context not available
    }
  }
}

/**
 * React hook that persists state across popup close/open cycles.
 *
 * @param key Unique storage key (auto-prefixed with "arfhe_ps_")
 * @param defaultValue Default value if nothing is persisted
 * @returns [value, setValue] — same API as useState
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  // Initialize with sync read (sessionStorage) for instant render
  const [state, setStateRaw] = useState<T>(() => {
    const synced = readSync<T>(key);
    return synced !== undefined ? synced : defaultValue;
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // The latest value a debounced write hasn't landed yet, plus whether one is actually
  // pending — a separate flag rather than testing the value for null/undefined, since T
  // itself may legitimately be null or undefined for some callers.
  const pendingWriteRef = useRef<T | undefined>(undefined);
  const hasPendingWriteRef = useRef(false);

  // On mount: async read from chrome.storage.session (may override sync value)
  useEffect(() => {
    mountedRef.current = true;
    readAsync<T>(key).then((asyncValue) => {
      if (mountedRef.current && asyncValue !== undefined) {
        setStateRaw(asyncValue);
      }
    });
    return () => {
      mountedRef.current = false;
      // A pending debounced write must be FLUSHED here, not just cancelled. Cancelling was
      // silently dropping the most recent update whenever the owning component unmounted
      // inside the 300ms window — e.g. the Agent page's chat history the instant a reply
      // landed just before the user switched tabs or closed the popup — so the update never
      // reached chrome.storage.session and reopening showed stale state, indistinguishable
      // from "the operation was cancelled" even though the in-memory update had happened.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (hasPendingWriteRef.current) {
          void write(key, pendingWriteRef.current as T);
        }
      }
    };
  }, [key]);

  // Setter with debounced persistence
  const setState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStateRaw((prev) => {
        const next = typeof value === "function"
          ? (value as (prev: T) => T)(prev)
          : value;

        // Debounce the write
        if (debounceRef.current) clearTimeout(debounceRef.current);
        pendingWriteRef.current = next;
        hasPendingWriteRef.current = true;
        debounceRef.current = setTimeout(() => {
          write(key, next);
          hasPendingWriteRef.current = false;
        }, DEBOUNCE_MS);

        return next;
      });
    },
    [key]
  );

  return [state, setState];
}

export default usePersistedState;
