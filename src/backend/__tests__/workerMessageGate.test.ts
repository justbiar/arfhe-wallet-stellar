/**
 * The service worker's privileged-message gate.
 *
 * `handleMessage` can fetch arbitrary URLs with the extension's host permissions, repoint
 * RPC endpoints, raise wallet-branded notifications and read the pending-transaction list.
 * One predicate decides who reaches it, and both ways of getting that predicate wrong are
 * expensive: too strict and the approval window cannot read the request it was opened to
 * show, too loose and any website can drive the wallet through its content script.
 *
 * It has been wrong in both directions already — first `sender.tab && message.method`,
 * which let a page message with no `method` through to the privileged handler; then
 * `!sender.tab`, which locked out every extension page that is not the browser-action
 * popup, the approval window included. Hence a test that pins both edges.
 *
 * The function is lifted out of `service-worker.js` rather than imported: the worker is a
 * plain script that installs Chrome listeners at load, so importing it would run them.
 * Reading the shipped source keeps this honest — it tests the code that ships, and fails
 * loudly if the gate is renamed or moved.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const EXTENSION_ID = "jdihllmgakeejednibihnpclbddgfchp";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

interface Sender {
  id?: string;
  tab?: { id: number };
  origin?: string;
  url?: string;
}

/** Pull the gate out of the worker source and bind it to a stub `chrome`. */
function loadGate(): (sender: Sender) => boolean {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../service-worker.js"),
    "utf8"
  );

  const start = source.indexOf("const EXTENSION_ORIGIN");
  const end = source.indexOf("chrome.runtime.onMessage.addListener");
  expect(start, "EXTENSION_ORIGIN not found in service-worker.js").toBeGreaterThan(-1);
  expect(end, "onMessage listener not found in service-worker.js").toBeGreaterThan(start);

  const chrome = {
    runtime: { id: EXTENSION_ID, getURL: (p: string) => `${ORIGIN}/${p}` },
  };

  return new Function(
    "chrome",
    source.slice(start, end) + "\nreturn isFromOwnExtensionPage;"
  )(chrome);
}

describe("service worker privileged-message gate", () => {
  const gate = loadGate();

  it("eylem açılır penceresini kabul eder", () => {
    // No tab: the browser-action popup. This is the case that always worked.
    expect(gate({ id: EXTENSION_ID, origin: ORIGIN, url: `${ORIGIN}/index.html` })).toBe(true);
  });

  it("onay penceresini kabul eder — sekme içinde olsa bile", () => {
    // Opened with windows.create, so its document lives in a tab. Rejecting this left the
    // window unable to read the request it exists to show, or to send the answer back.
    expect(
      gate({
        id: EXTENSION_ID,
        tab: { id: 7 },
        origin: ORIGIN,
        url: `${ORIGIN}/index.html#/approve?requestId=1`,
      })
    ).toBe(true);
  });

  it("origin alanı olmayan eski Chrome'da URL'ye düşer", () => {
    expect(gate({ id: EXTENSION_ID, tab: { id: 7 }, url: `${ORIGIN}/index.html` })).toBe(true);
  });

  it("web sayfasındaki content script'i reddeder", () => {
    // A content script carries the extension's own id, which is exactly why the id alone
    // cannot be the test. Any site could otherwise reach the privileged surface.
    expect(
      gate({ id: EXTENSION_ID, tab: { id: 3 }, origin: "https://evil.example", url: "https://evil.example/x" })
    ).toBe(false);
  });

  it("kaynağı olmayan çerçeveyi reddeder", () => {
    // A sandboxed iframe reports the string "null".
    expect(gate({ id: EXTENSION_ID, tab: { id: 3 }, origin: "null", url: "file:///tmp/x.html" })).toBe(false);
  });

  it("doğru kimlikle sahte kaynağı reddeder", () => {
    expect(gate({ id: EXTENSION_ID, tab: { id: 3 }, origin: "https://evil.example" })).toBe(false);
  });

  it("benzeyen bir eklenti kimliğini reddeder", () => {
    // The trailing slash in the URL fallback is what stops an id that merely starts with
    // ours from passing the prefix test.
    expect(gate({ id: EXTENSION_ID, url: `${ORIGIN}extra/index.html` })).toBe(false);
  });

  it("başka bir eklentiyi reddeder", () => {
    const other = "a".repeat(32);
    expect(gate({ id: other, origin: `chrome-extension://${other}` })).toBe(false);
  });

  it("hiçbir bilgi taşımayan göndereni reddeder", () => {
    expect(gate({ id: EXTENSION_ID })).toBe(false);
    expect(gate({})).toBe(false);
  });
});
