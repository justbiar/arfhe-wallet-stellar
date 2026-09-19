/**
 * Panel entry point.
 *
 * Three routes, in the order a visitor meets them: the landing page, the split-screen demo
 * where a bank sits beside the wallet, and a page explaining what Arfhe Wallet is.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router";
import { ThemeProvider, CssBaseline } from "@mui/material";
import getTheme from "@wallet/components/ArfTheme";

import "./panel.css";

import Landing from "./pages/Landing";
import Bridge from "./pages/Bridge";
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
