import { Buffer } from 'buffer';

/**
 * Tell the stylesheet which surface this document was opened as.
 *
 * The same index.html is the side panel, the approval window, and (historically) the popup.
 * A popup is a fixed 400px column and the CSS pins the layout to that; a side panel is
 * whatever width the user has dragged it to, and holding it at 400 there leaves a dead strip
 * beside the wallet or forces a horizontal scrollbar when they narrow it.
 *
 * Read from a query parameter set in the manifest's `side_panel.default_path` rather than
 * sniffed at runtime: the surface is a fact the manifest already knows, and a guess based on
 * window dimensions would be wrong the moment someone resized something.
 */
(() => {
  try {
    const surface = new URLSearchParams(window.location.search).get("surface");
    if (surface) document.documentElement.setAttribute("data-surface", surface);
  } catch {
    // Leaves the default (popup-width) layout in place, which is readable everywhere.
  }
})();



if (typeof window !== 'undefined') {
  window.global = window;
  window.Buffer = window.Buffer || Buffer;
}

// WalletConnect's SDK compares our fixed brand `metadata.url` (https://arfhewallet.com, shown
// to dApps as the wallet's identity) against the page's actual URL and warns when they differ.
// Inside a Chrome extension the page URL is always chrome-extension://<random-id>/... — it can
// never match a real https:// domain, so this warning is guaranteed to fire on every session
// and is not actionable (see WalletConnectService.ts's METADATA constant). Filter only this
// exact, known-benign message; everything else still reaches the real console.warn.
if (typeof console !== 'undefined') {
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes("configured WalletConnect 'metadata.url'")) {
      return;
    }
    originalWarn(...args);
  };
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'  // Initialize i18n before app renders
import './index.css'
import AppRouter from './AppRouter'
import { HashRouter } from 'react-router'
import ErrorBoundary from './components/ErrorBoundary'

import { ToastProvider } from './components/ToastProvider'

const root = document.getElementById('root')!;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <ToastProvider>
          <AppRouter />
        </ToastProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
)
