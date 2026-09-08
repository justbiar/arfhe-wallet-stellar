/**
 * RequireUnlocked — nothing inside the wallet renders unless the wallet is actually open.
 *
 * The screens under AppLayout used to render for anyone who reached their URL. Normally
 * nobody does: the app enters at the splash, which sends you to Auth, which decides what
 * you are allowed to see. But the address bar is not the only way in — the back button is
 * one too, and hash history survives across an erase-and-recreate. Backing out of the
 * recovery-phrase screen and pressing back twice landed on `#/home`, where a freshly
 * created account was sitting in memory: a fully usable wallet on which no password had
 * ever been set, holding a seed the user had not finished writing down.
 *
 * That was one route into it. This guard is written to close the class rather than that
 * path: the question it asks is not "how did you get here" but "is there a key in memory
 * right now", which is the same question every screen behind it implicitly assumes has
 * already been answered yes.
 *
 * Being locked is not an error and gets no message — Auth is where the user belongs, and
 * `replace` keeps the guarded URL out of history so Back does not bounce between them.
 */

import React from "react";
import { Navigate } from "react-router";
import { WalletContext } from "./AppContext";
import { PageSkeleton } from "./components/SkeletonLoaders";

export default function RequireUnlocked({ children }: { children: React.ReactNode }) {
    const appContext = React.useContext(WalletContext);
    const storageManager = appContext?.storageManager;

    // The provider has not finished constructing its services. Redirecting on this would
    // throw a legitimately unlocked user back to Auth on every reload, so it waits instead
    // — and waiting is safe, because nothing below has rendered.
    if (!storageManager) return <PageSkeleton />;

    if (!storageManager.isUnlocked()) return <Navigate to="/auth" replace />;

    return <>{children}</>;
}
