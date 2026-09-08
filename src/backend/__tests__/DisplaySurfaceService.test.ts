/// <reference types="vitest/globals" />

/**
 * The surface marker, which two separate behaviours now hang off.
 *
 * The auto-lock rule and the social-login flow both need to know whether this document
 * survives losing focus, and both used to get it wrong in the same way: they tested for
 * "is this a tab", and the side panel is not one. Reading the marker names the surface
 * directly, so a panel is never mistaken for the action popup again.
 */

import { currentSurface, DEFAULT_DISPLAY_SURFACE } from '../DisplaySurfaceService';

function setSearch(search: string): void {
    window.history.replaceState({}, '', `/index.html${search}`);
}

describe('currentSurface', () => {
    afterEach(() => setSearch(''));

    it('yan panel işaretini tanır', () => {
        setSearch('?surface=sidepanel');
        expect(currentSurface()).toBe('sidepanel');
    });

    it('açılır pencere işaretini tanır', () => {
        setSearch('?surface=popup');
        expect(currentSurface()).toBe('popup');
    });

    // Anything unmarked — a detached window, the dev server — is treated as a popup: the
    // shorter-lived assumption, which is the safe one for behaviour that depends on how
    // long the page lives.
    it('işaret yoksa açılır pencere varsayar', () => {
        setSearch('');
        expect(currentSurface()).toBe('popup');
    });

    it('tanınmayan işareti yan panel saymaz', () => {
        setSearch('?surface=sidebar');
        expect(currentSurface()).toBe('popup');
    });

    it('varsayılan tercih yan paneldir', () => {
        expect(DEFAULT_DISPLAY_SURFACE).toBe('sidepanel');
    });
});
