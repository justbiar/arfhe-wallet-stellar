/**
 * lazyWithRetry — React.lazy that survives a chunk it cannot fetch.
 *
 * Every page in this wallet is code-split, so navigating to one is a network fetch for a
 * hashed chunk. When that fetch fails the import rejects, and a rejected lazy import is
 * not a blank page — it propagates to the error boundary and takes the whole wallet down.
 * The user is looking at a crash screen because a file did not arrive.
 *
 * The usual cause is that the chunk genuinely is not there any more: the extension was
 * reloaded or updated while a page was open, so the document still holds the old build's
 * chunk names while the folder on disk has the new build's. Nothing about that is
 * recoverable in place — the fix is to reload the document, which re-reads index.html and
 * picks up the current names.
 *
 * So: retry once for a transient failure, then reload once for a stale one. The reload is
 * marked in sessionStorage so a chunk that is missing for some third reason cannot put the
 * wallet into a reload loop; the second time through, the error is allowed to reach the
 * boundary, which can at least explain itself and offer to clear caches.
 */

import React from "react";

/** Marks that a reload has already been spent on a chunk failure this session. */
const RELOAD_KEY = "arfhe_chunk_reload";

function alreadyReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_KEY) === "1";
  } catch {
    // No sessionStorage (private mode, storage-less context). Treat as "already used" so
    // a missing chunk cannot reload forever — the boundary is the safer failure.
    return true;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    /* nothing to do; alreadyReloaded() is conservative in this case */
  }
}

/**
 * Clear the reload mark.
 *
 * Called once the app has rendered successfully, so that a later update — the user leaves
 * the popup open across an extension reload — still gets its own reload rather than
 * landing on the crash screen because an unrelated failure used the budget hours earlier.
 */
export function noteChunkLoadSucceeded(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* as above */
  }
}

export default function lazyWithRetry<T extends React.ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    try {
      return await factory();
    } catch (firstError) {
      // A single immediate retry. Costs one round trip and covers the genuinely transient
      // case, where the file is there and the fetch lost.
      try {
        return await factory();
      } catch (secondError) {
        if (!alreadyReloaded()) {
          markReloaded();
          // Reload rather than navigate: the point is to re-read index.html and pick up
          // the current chunk names, which an in-page route change would not do.
          window.location.reload();
          // Never settles — the document is going away. Resolving here would render a
          // half-built page in the moment before the reload takes effect.
          return await new Promise<{ default: T }>(() => {});
        }
        throw secondError;
      }
    }
  });
}
