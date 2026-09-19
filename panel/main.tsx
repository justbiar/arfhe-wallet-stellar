/**
 * Panel entry point.
 *
 * Routes in the order a visitor meets them: the landing page, the split-screen ramp demo
 * where a bank sits beside the wallet, the confidential payment demo, the privacy pool,
 * and the pages explaining the anchor and the wallet itself.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router";
import { ThemeProvider, CssBaseline } from "@mui/material";
import getTheme from "./theme";
import { usePanelLanguage } from "./lib/language";

import "./panel.css";

import Landing from "./pages/Landing";
import Bridge from "./pages/Bridge";
import Payroll from "./pages/Payroll";
import Roadmap from "./pages/Roadmap";
import About from "./pages/About";
import Anchor from "./pages/Anchor";
import Privacy from "./pages/Privacy";
import Shell from "./components/Shell";

/**
 * Light by default.
 *
 * The extension follows the browser's colour scheme because it lives inside it. A landing
 * page is met cold, usually from a link, and the bone-paper light theme is the brand's
 * resting state — so this starts there and offers the toggle rather than guessing from the OS.
 */
function App() {
  // Re-render translated copy without remounting routes or losing an in-flight payment.
  usePanelLanguage();
  const [mode, setMode] = React.useState<"light" | "dark">("light");
  const theme = React.useMemo(() => getTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <HashRouter>
        <Shell mode={mode} onToggleMode={() => setMode((m) => (m === "light" ? "dark" : "light"))}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/bridge" element={<Bridge />} />
            <Route path="/payroll" element={<Payroll />} />
            <Route path="/roadmap" element={<Roadmap />} />
            <Route path="/anchor" element={<Anchor />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </Shell>
      </HashRouter>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
