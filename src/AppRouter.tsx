import { Routes, Route } from "react-router"
import AppLayout from "./AppLayout";
import Splash from "./pages/Splash";
import Auth from "./pages/Auth";
import { ThemeProvider, CssBaseline, Fade } from "@mui/material";
import { ColorModeProvider, ColorModeContext } from "./ThemeContext";
import { getTheme } from "./components/ArfTheme";
import React, { useContext, useMemo, Suspense } from "react";
import { PageSkeleton } from "./components/SkeletonLoaders";
import lazyWithRetry, { noteChunkLoadSucceeded } from "./lazyWithRetry";

// Lazy-loaded pages — only downloaded when navigated to.
//
// Through lazyWithRetry rather than React.lazy: a chunk that fails to arrive otherwise
// rejects straight into the error boundary and the whole wallet is a crash screen. That
// happens for a mundane reason — the extension was reloaded or updated while this page was
// open, so the document is asking for the previous build's file names.
const Home = lazyWithRetry(() => import("./pages/Home"));
const Portfolio = lazyWithRetry(() => import("./pages/Portfolio"));
const Privacy = lazyWithRetry(() => import("./pages/Privacy"));
const Bank = lazyWithRetry(() => import("./pages/Bank"));
const Explore = lazyWithRetry(() => import("./pages/Explore"));
const History = lazyWithRetry(() => import("./pages/History"));
const Revoke = lazyWithRetry(() => import("./pages/Revoke"));
const Agent = lazyWithRetry(() => import("./pages/Agent"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const SettingsSecurity = lazyWithRetry(() => import("./pages/SettingsSecurity"));
const SettingsNetworks = lazyWithRetry(() => import("./pages/SettingsNetworks"));
const SettingsStellar = lazyWithRetry(() => import("./pages/SettingsStellar"));
const SettingsAccounts = lazyWithRetry(() => import("./pages/SettingsAccounts"));
const SettingsNotifications = lazyWithRetry(() => import("./pages/SettingsNotifications"));
const TokenDetail = lazyWithRetry(() => import("./pages/TokenDetail"));
const NotFound = lazyWithRetry(() => import("./pages/NotFound"));
// Opened by the service worker in its own window for injected-provider requests.
// Deliberately outside AppLayout: no nav chrome belongs on an approval screen.
const Approve = lazyWithRetry(() => import("./pages/Approve"));

// Wrap a route element in a smooth Fade transition
const FadePage = React.memo(function FadePage({ children }: { children: React.ReactNode }) {
  return <Fade in timeout={280}>{<div style={{ display: 'contents' }}>{children}</div>}</Fade>;
});


import { WalletProvider } from "./WalletProvider";
import RequireUnlocked from "./RequireUnlocked";
import { ActiveAccountProvider } from "./ActiveAccountProvider";

function AppRoutes() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="auth" element={<Auth />} />
        <Route path="approve" element={<Approve />} />

        {/* Everything below is the wallet itself, and none of it may render on a locked
            wallet — including a wallet mid-creation, which is locked precisely because no
            password has been set on it yet. */}
        <Route element={<RequireUnlocked><AppLayout /></RequireUnlocked>}>
          <Route path="home" element={<FadePage><Home /></FadePage>} />
          <Route path="portfolio" element={<FadePage><Portfolio /></FadePage>} />
          <Route path="privacy" element={<FadePage><Privacy /></FadePage>} />
          <Route path="bank" element={<FadePage><Bank /></FadePage>} />
          <Route path="explore" element={<FadePage><Explore /></FadePage>} />
          <Route path="history" element={<FadePage><History /></FadePage>} />
          <Route path="revoke" element={<FadePage><Revoke /></FadePage>} />
          <Route path="agent" element={<FadePage><Agent /></FadePage>} />
          <Route path="settings" element={<FadePage><Settings /></FadePage>} />
          <Route path="settings/security" element={<FadePage><SettingsSecurity /></FadePage>} />
          <Route path="settings/networks" element={<FadePage><SettingsNetworks /></FadePage>} />
          <Route path="settings/stellar" element={<FadePage><SettingsStellar /></FadePage>} />
          <Route path="settings/accounts" element={<FadePage><SettingsAccounts /></FadePage>} />
          <Route path="settings/notifications" element={<FadePage><SettingsNotifications /></FadePage>} />
          <Route path="token/:address" element={<FadePage><TokenDetail /></FadePage>} />
          <Route path="*" element={<FadePage><NotFound /></FadePage>} />
        </Route>

      </Routes>
    </Suspense>
  );
}

function ThemedApp() {
  const { mode } = useContext(ColorModeContext);
  const theme = useMemo(() => getTheme(mode), [mode]);

  // Reaching here means the app mounted, so whatever chunk failure spent the one-shot
  // reload earlier is behind us. Hand the budget back: a user who leaves the popup open
  // across a later extension update should get their own reload rather than a crash
  // screen because an unrelated failure used it hours ago.
  React.useEffect(() => {
    noteChunkLoadSucceeded();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <WalletProvider>
        <AppRoutes />
      </WalletProvider>
    </ThemeProvider>
  );
}

function AppRouter() {
  return (
    <ColorModeProvider>
      <ThemedApp />
    </ColorModeProvider>
  );
};

export default AppRouter;


