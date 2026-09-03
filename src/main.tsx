import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
  window.global = window;
  window.Buffer = window.Buffer || Buffer;
}

// WalletConnect's SDK compares our fixed brand `metadata.url` (https://arfhewallet.dev, shown
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
