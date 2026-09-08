/// <reference types="vitest/globals" />

/**
 * The guard that closes the "wallet reachable before a password exists" hole.
 *
 * The original bug: creating a wallet added the account the moment the recovery phrase was
 * displayed, and every screen under AppLayout rendered for anyone whose URL reached it. The
 * back button was enough — back out of the phrase screen, press back again, and the home
 * screen of a password-less wallet appeared. These tests hold the invariant that closes it:
 * a locked wallet renders none of that, whatever route asked for it.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import RequireUnlocked from "../RequireUnlocked";
import { WalletContext, AppContext } from "../AppContext";
import type StorageManager from "../backend/StorageManager";

function renderAt(path: string, storageManager: StorageManager | undefined) {
    const context = storageManager
        ? ({ storageManager } as unknown as AppContext)
        : undefined;

    return render(
        <WalletContext.Provider value={context}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/auth" element={<div>auth screen</div>} />
                    <Route
                        path="/home"
                        element={<RequireUnlocked><div>wallet home</div></RequireUnlocked>}
                    />
                </Routes>
            </MemoryRouter>
        </WalletContext.Provider>,
    );
}

const lockedManager = { isUnlocked: () => false } as unknown as StorageManager;
const unlockedManager = { isUnlocked: () => true } as unknown as StorageManager;

describe("RequireUnlocked", () => {
    it("kilitli cüzdanda korunan ekranı göstermez, /auth'a yollar", () => {
        renderAt("/home", lockedManager);
        expect(screen.queryByText("wallet home")).toBeNull();
        expect(screen.getByText("auth screen")).toBeTruthy();
    });

    it("açık cüzdanda korunan ekranı gösterir", () => {
        renderAt("/home", unlockedManager);
        expect(screen.getByText("wallet home")).toBeTruthy();
    });

    // Redirecting while the provider is still constructing would throw a legitimately
    // unlocked user back to Auth on every reload. Waiting is safe: nothing below rendered.
    it("depolama yöneticisi henüz yokken ne içeriği gösterir ne de yönlendirir", () => {
        renderAt("/home", undefined);
        expect(screen.queryByText("wallet home")).toBeNull();
        expect(screen.queryByText("auth screen")).toBeNull();
    });
});
