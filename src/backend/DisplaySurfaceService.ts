/**
 * Whether the toolbar button opens the wallet as a side panel or as a popup.
 *
 * Both are real preferences rather than a right answer. A side panel stays open while the
 * user works on the page beside it, which is what someone comparing a balance against a
 * site wants. A popup is smaller, closes itself when attention moves, and is what people
 * arriving from other wallets expect the button to do. Chrome can do either, but not both
 * at once — the choice has to be stored somewhere and applied to the action.
 *
 * Stored in `chrome.storage.local` rather than sent as a message, because the service
 * worker is the only thing that can apply it and it can be evicted at any moment. Storage
 * survives that; a message to a dead worker does not, and the worker re-reads this key on
 * every wake.
 */

export type DisplaySurface = "sidepanel" | "popup";

export const DISPLAY_SURFACE_KEY = "arfhe_display_surface";

export const DEFAULT_DISPLAY_SURFACE: DisplaySurface = "sidepanel";

function isSurface(value: unknown): value is DisplaySurface {
    return value === "sidepanel" || value === "popup";
}

/** Falls back to the default rather than throwing — outside the extension there is no store. */
export async function getDisplaySurface(): Promise<DisplaySurface> {
    try {
        const stored = await chrome?.storage?.local?.get(DISPLAY_SURFACE_KEY);
        const value = stored?.[DISPLAY_SURFACE_KEY];
        return isSurface(value) ? value : DEFAULT_DISPLAY_SURFACE;
    } catch {
        return DEFAULT_DISPLAY_SURFACE;
    }
}

/**
 * Write the preference and have the worker apply it before returning.
 *
 * Two steps, because they answer different questions. The write is what survives the
 * worker being evicted, and the worker's storage listener applies it on its own. But a
 * listener cannot report back, so the switch had no way to tell a preference that took
 * from one that silently did not — which is exactly the failure it was showing. The
 * message is what makes the answer real.
 *
 * @returns whether the toolbar button is now actually doing what the switch says, and the
 *          worker's own error when it is not — a generic "could not save" tells the user
 *          nothing and tells whoever has to fix it even less.
 */
export async function setDisplaySurface(
    surface: DisplaySurface,
): Promise<{ ok: boolean; error?: string }> {
    try {
        await chrome?.storage?.local?.set({ [DISPLAY_SURFACE_KEY]: surface });
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    try {
        const applied = await chrome?.runtime?.sendMessage({ type: "APPLY_DISPLAY_SURFACE" });
        // A worker that was mid-restart returns nothing. The preference is written and its
        // storage listener will apply it on wake, so this is not a failure — only an answer
        // that did not arrive.
        if (applied && applied.ok === false) {
            return { ok: false, error: applied.error || "the worker could not apply it" };
        }
        return { ok: true };
    } catch (e) {
        // Reported rather than swallowed. This used to return success: a `sendMessage` that
        // throws means the worker never handled the request, and calling that "applied"
        // turned the one case worth investigating into a switch that slid across and did
        // nothing. The stored preference may still be picked up by the worker's storage
        // listener, but that is a hope, not a confirmation, and the switch should not
        // present a hope as a fact.
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** True only in a context that can actually honour the preference. */
export function displaySurfaceSupported(): boolean {
    return typeof chrome !== "undefined" && !!chrome.storage?.local && !!chrome.sidePanel;
}

/**
 * Which surface *this page* is rendering into, read from the URL marker the manifest and
 * the popup path both carry.
 *
 * This is not the same question as `getDisplaySurface()`. That is the preference; this is
 * the fact about the document currently running, and the two can disagree for as long as a
 * panel opened under the old preference is still on screen.
 *
 * Anything without the marker — a detached tab, the dev server — is treated as a popup,
 * because a popup is the shorter-lived assumption and the behaviour that depends on this is
 * about how long the page is expected to live.
 */
export function currentSurface(): DisplaySurface {
    try {
        return new URLSearchParams(window.location.search).get("surface") === "sidepanel"
            ? "sidepanel"
            : "popup";
    } catch {
        return "popup";
    }
}

/** Where a side panel can be opened: a browser tab, and the window holding it. */
export interface PanelTarget {
    tabId: number | null;
    windowId: number | null;
}

/**
 * Open the side panel now, from the click that asked for it.
 *
 * `chrome.sidePanel.open()` is refused unless it is made in response to a live user
 * gesture, and a gesture does not survive being forwarded to the service worker as a
 * message — which is why the worker's own attempt fails with "may only be called in
 * response to a user gesture" every time.
 *
 * A gesture also does not survive an `await`, so the target has to be in hand before the
 * click arrives; {@link panelTarget} is for fetching it ahead of time. Call this as the
 * first statement of the handler, before anything is awaited.
 *
 * Prefers the tab. A side panel belongs to a browser tab or the window around one, and
 * asking for a window id read from inside an extension popup gets the popup's own record
 * back — a window that cannot have a side panel, which Chrome reports as "no active side
 * panel for windowId" and which is not a sentence about the panel being disabled at all.
 *
 * @returns The call's promise, or null when there is nothing to call.
 */
export function openSidePanelNow(target: PanelTarget): Promise<void> | null {
    const { tabId, windowId } = target;
    try {
        if (tabId !== null) return chrome?.sidePanel?.open({ tabId }) ?? null;
        if (windowId !== null) return chrome?.sidePanel?.open({ windowId }) ?? null;
        return null;
    } catch {
        return null;
    }
}

/**
 * The tab a side panel would open beside, to be fetched before a click needs it.
 *
 * Read from the active tab rather than from `windows.getCurrent()`: this code runs inside
 * the wallet's own popup or panel, and "current window" from there is not reliably the
 * browser window the user is looking at.
 */
export async function panelTarget(): Promise<PanelTarget> {
    try {
        const tabs = await chrome?.tabs?.query({ active: true, lastFocusedWindow: true });
        const tab = tabs?.[0];
        if (typeof tab?.id === "number") {
            return { tabId: tab.id, windowId: typeof tab.windowId === "number" ? tab.windowId : null };
        }
    } catch {
        /* fall through to the window lookup */
    }

    try {
        const window = await chrome?.windows?.getLastFocused();
        return { tabId: null, windowId: typeof window?.id === "number" ? window.id : null };
    } catch {
        return { tabId: null, windowId: null };
    }
}
