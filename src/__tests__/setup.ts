/// <reference types="vitest/globals" />
import '@testing-library/jest-dom';

// ─── Buffer polyfill fix for ethers.js ─────────────────────────
// In jsdom/vitest, the `buffer` npm polyfill replaces globalThis.Buffer
// which causes ethers.js sha256 to fail (expects Uint8Array, gets Buffer).
// Fix: ensure globalThis.Buffer is the native Node.js Buffer.
import { Buffer as NodeBuffer } from 'node:buffer';
globalThis.Buffer = NodeBuffer;

// ─── Chrome Extension API Mock ─────────────────────────────────
// Mock chrome.storage for tests that use StorageManager.
//
// The real API is dual-form: with a callback it calls back, without one it returns a
// promise. Production code here uses the promise form (`await chrome.storage.session.get`),
// so a callback-only mock threw on every call — and because those call sites catch their
// own errors, the failure surfaced as "session could not be restored" rather than as a
// broken test double. Both forms are modelled.
function makeArea() {
  const area = {
    _store: {} as Record<string, any>,

    get: vi.fn((keys?: string | string[] | null, callback?: (result: Record<string, any>) => void) => {
      const list = keys == null ? Object.keys(area._store) : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, any> = {};
      for (const key of list) {
        if (key in area._store) result[key] = area._store[key];
      }
      if (callback) { callback(result); return undefined; }
      return Promise.resolve(result);
    }),

    set: vi.fn((items: Record<string, any>, callback?: () => void) => {
      Object.assign(area._store, items);
      if (callback) { callback(); return undefined; }
      return Promise.resolve();
    }),

    remove: vi.fn((keys: string | string[], callback?: () => void) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete area._store[key];
      if (callback) { callback(); return undefined; }
      return Promise.resolve();
    }),

    clear: vi.fn((callback?: () => void) => {
      area._store = {};
      if (callback) { callback(); return undefined; }
      return Promise.resolve();
    }),

    setAccessLevel: vi.fn(() => Promise.resolve()),
  };
  return area;
}

const chromeStorageMock = {
  local: makeArea(),
  session: makeArea(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Chrome runtime mock for test environment
(globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
  storage: chromeStorageMock,
  runtime: {
    id: 'test-extension-id',
    getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
  },
};

// ─── Reset mocks between tests ─────────────────────────────────
beforeEach(() => {
  chromeStorageMock.local._store = {};
  chromeStorageMock.session._store = {};
});

// ─── scrollIntoView polyfill (jsdom doesn't implement it) ───────
// Needed by any component that auto-scrolls a chat/list container (e.g. AgentChatPanel).
// Guarded because backend tests run under `@vitest-environment node`, where `Element`
// doesn't exist at all.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// ─── Web Crypto polyfill (jsdom has limited support) ────────────
// jsdom now ships with a functional crypto.subtle, but if needed:
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = require('crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

// ─── ResizeObserver polyfill (jsdom doesn't implement it) ───────
// recharts' ResponsiveContainer observes its parent to size the SVG. jsdom has no layout
// engine, so the observed box is always zero — which is fine: these tests assert the text
// and structure around a chart, never its pixels.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
