import React from "react";
import i18n from "../i18n";

/**
 * ErrorBoundary — what the user sees when the wallet's interface stops working.
 *
 * This screen sits outside every provider: no theme, no router, no wallet context. That
 * is deliberate — it has to survive a failure in any of them — but it means it cannot
 * borrow the app's styling and has to carry its own.
 *
 * The recovery it offers is graduated, because "try again" is only the right answer the
 * first time. Re-rendering the subtree that just threw, with the state that made it throw,
 * fails again immediately; that is what the previous version did, and why its retry button
 * did nothing. So:
 *
 *   1. **Try again** — a real remount, not a flag reset. Fixes a transient render error.
 *   2. **Restart** — reload the extension page from the top. Fixes anything left in bad
 *      memory state, which a remount inside the same document cannot.
 *   3. **Clear cached data** — offered only once the wallet has failed more than once,
 *      because at that point the problem is stored rather than transient.
 *
 * On the third: everything it removes is re-read from the chain. It is built as an
 * allowlist of cache keys and never as "delete everything except the important ones" —
 * in a wallet, that phrasing is one forgotten key away from destroying funds. The
 * encrypted vault, the accounts, the recovery phrase, contacts and — importantly —
 * pending unshield claims are not in the list. A pending claim is burned balance waiting
 * to be settled; deleting the record of it would lose real money.
 */

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string;
  /** Bumped to force a genuine remount of the children rather than a re-render. */
  resetKey: number;
  showDetails: boolean;
  copied: boolean;
  confirmingClear: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

/**
 * Storage entries that are caches: derived from the chain and rebuilt on next load.
 *
 * Anything not named here is left alone. The list is short on purpose — a key is only
 * added once it is certain that losing it costs the user nothing but a refetch.
 */
const CACHE_KEYS = [
  "arfhe_token_cache",
  "arfhe_token_cache_version",
  "arfhe_nft_cache",
  "arfhe_known_tokens",
  // The active network. Included because a network entry the wallet can no longer make
  // sense of is one of the few stored values that can crash it on every single load.
  "arfhe_ps_active_network",
];

/** Encrypted entries that are caches. Stored by StorageManager under an `enc_` prefix. */
const ENCRYPTED_CACHE_KEYS = ["portfolio_cache"];

/** How many failures this session. Kept in sessionStorage so it survives the reload. */
const CRASH_COUNT_KEY = "arfhe_crash_count";

function readCrashCount(): number {
  try {
    return Number(sessionStorage.getItem(CRASH_COUNT_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeCrashCount(n: number): void {
  try {
    sessionStorage.setItem(CRASH_COUNT_KEY, String(n));
  } catch {
    // Private mode or a storage-less context. The panel degrades to always offering the
    // first-failure actions, which is the safe direction to be wrong in.
  }
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      error: null,
      componentStack: "",
      resetKey: 0,
      showDetails: false,
      copied: false,
      confirmingClear: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // The component stack is the only thing that says *where* this happened, and the
    // previous version discarded it. It is kept in state rather than sent anywhere: this
    // is a wallet, and an error report is not worth a network call the user did not ask
    // for. The copy button is how it leaves the machine, if the user decides it should.
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
    writeCrashCount(readCrashCount() + 1);
    console.error("Arfhe wallet crashed:", error, errorInfo.componentStack);
  }

  /** Remount the subtree. A cleared flag alone re-renders the same failing tree. */
  private handleRetry = () => {
    this.setState((s) => ({
      error: null,
      componentStack: "",
      resetKey: s.resetKey + 1,
      showDetails: false,
      confirmingClear: false,
    }));
  };

  /** Reload the document from the top — the only way to drop bad in-memory state. */
  private handleRestart = () => {
    window.location.hash = "#/";
    window.location.reload();
  };

  private handleCopy = async () => {
    const { error, componentStack } = this.state;
    const report = [
      `Arfhe Wallet — crash report`,
      `when: ${new Date().toISOString()}`,
      `failures this session: ${readCrashCount()}`,
      `agent: ${navigator.userAgent}`,
      ``,
      `${error?.name ?? "Error"}: ${error?.message ?? "(no message)"}`,
      ``,
      error?.stack ?? "(no stack)",
      ``,
      `component stack:${componentStack || " (unavailable)"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 3000);
    } catch {
      // No clipboard access. The details panel shows the same text to read manually.
      this.setState({ showDetails: true });
    }
  };

  /**
   * Remove the cache entries and restart.
   *
   * Deliberately synchronous and local: it must work when the wallet is too broken to
   * load, so it touches storage directly rather than going through the services that
   * normally own these keys.
   */
  private handleClearCaches = () => {
    for (const key of CACHE_KEYS) {
      try { localStorage.removeItem(key); } catch { /* keep going; one failure is not fatal */ }
      try {
        if (typeof chrome !== "undefined") void chrome.storage?.local?.remove(key);
      } catch { /* not an extension context */ }
    }

    for (const key of ENCRYPTED_CACHE_KEYS) {
      try { localStorage.removeItem(`enc_${key}`); } catch { /* as above */ }
    }

    // StorageManager keeps a list of which encrypted entries exist, and walks it when the
    // password changes. Leaving a name in it for an entry that is gone would make that
    // walk trip over a key it cannot read.
    try {
      const raw = localStorage.getItem("arfhe_enc_keys");
      if (raw) {
        const tracked = JSON.parse(raw) as string[];
        const kept = tracked.filter((k) => !ENCRYPTED_CACHE_KEYS.includes(k));
        localStorage.setItem("arfhe_enc_keys", JSON.stringify(kept));
      }
    } catch { /* the list is a convenience, not the source of truth */ }

    writeCrashCount(0);
    this.handleRestart();
  };

  render() {
    if (!this.state.error) {
      return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
    }

    const t = i18n.t.bind(i18n);
    const crashes = readCrashCount();
    // One failure is plausibly transient. A second, after a restart, is not — that is when
    // clearing stored state stops being an overreaction.
    const repeated = crashes > 1;
    const { error, componentStack, showDetails, copied, confirmingClear } = this.state;

    return (
      <div className="arf-crash" data-mode={savedMode()} style={S.root}>
        <style>{THEME_CSS}</style>

        <div style={S.panel}>
          <div style={S.mark} aria-hidden="true">!</div>

          <h1 style={S.title}>{t("errorBoundary.title")}</h1>

          <p style={S.body}>
            {repeated ? t("errorBoundary.descriptionRepeat") : t("errorBoundary.description")}
          </p>

          {repeated && (
            <div style={S.attempt}>{t("errorBoundary.attempt", { n: crashes })}</div>
          )}

          {/* ── Actions, most conservative first ── */}
          {!confirmingClear ? (
            <div style={S.actions}>
              {!repeated && (
                <button style={S.primary} className="arf-btn" onClick={this.handleRetry}>
                  {t("errorBoundary.retry")}
                </button>
              )}

              <button
                style={repeated ? S.primary : S.secondary}
                className="arf-btn"
                onClick={this.handleRestart}
              >
                {t("errorBoundary.restart")}
              </button>

              {repeated && (
                <button
                  style={S.secondary}
                  className="arf-btn"
                  onClick={() => this.setState({ confirmingClear: true })}
                >
                  {t("errorBoundary.clearCaches")}
                </button>
              )}
            </div>
          ) : (
            <div style={S.confirm}>
              <div style={S.confirmTitle}>{t("errorBoundary.clearConfirm")}</div>
              {/* What survives is spelled out, because "clear data" in a wallet is a
                  sentence people are right to be afraid of. */}
              <p style={S.confirmBody}>{t("errorBoundary.clearCachesExplain")}</p>
              <div style={S.actions}>
                <button style={S.primary} className="arf-btn" onClick={this.handleClearCaches}>
                  {t("errorBoundary.clearConfirmYes")}
                </button>
                <button
                  style={S.secondary}
                  className="arf-btn"
                  onClick={() => this.setState({ confirmingClear: false })}
                >
                  {t("errorBoundary.clearConfirmNo")}
                </button>
              </div>
            </div>
          )}

          {/* ── Diagnostics, folded away ── */}
          <div style={S.detailsWrap}>
            <button
              style={S.link}
              className="arf-link"
              onClick={() => this.setState({ showDetails: !showDetails })}
              aria-expanded={showDetails}
            >
              {t("errorBoundary.details")} {showDetails ? "▴" : "▾"}
            </button>
            <button style={S.link} className="arf-link" onClick={this.handleCopy}>
              {copied ? t("errorBoundary.copied") : t("errorBoundary.copy")}
            </button>
          </div>

          {showDetails && (
            <pre style={S.pre}>
              {`${error.name}: ${error.message}\n\n${error.stack ?? ""}${componentStack}`}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

/**
 * The panel's own palette.
 *
 * MUI is unavailable here — the boundary wraps the ThemeProvider, so a failure inside it
 * still has to render. The two token sets are the app's own light and dark surfaces,
 * copied rather than imported so that a broken theme module cannot take this screen down
 * with it. `prefers-color-scheme` picks between them, with the user's saved choice, when
 * it is readable, winning over it.
 */
const THEME_CSS = `
.arf-crash {
  --bg: #F2F0E9; --fg: #0D0D0D; --muted: #5C5C58; --border: #D1D1D1;
  --accent: #4338CA; --accent-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  .arf-crash {
    --bg: #0D0F12; --fg: #F2F0E9; --muted: #9A9FA6; --border: #2A2E35;
    --accent: #00E676; --accent-fg: #000000;
  }
}
.arf-crash[data-mode="light"] {
  --bg: #F2F0E9; --fg: #0D0D0D; --muted: #5C5C58; --border: #D1D1D1;
  --accent: #4338CA; --accent-fg: #ffffff;
}
.arf-crash[data-mode="dark"] {
  --bg: #0D0F12; --fg: #F2F0E9; --muted: #9A9FA6; --border: #2A2E35;
  --accent: #00E676; --accent-fg: #000000;
}
.arf-crash .arf-btn { transition: opacity .15s ease; }
.arf-crash .arf-btn:hover { opacity: .85; }
.arf-crash .arf-link:hover { color: var(--fg); }
`;

/** The mode the user chose, when it can still be read. */
function savedMode(): string {
  try {
    const saved = localStorage.getItem("arfhe_theme_mode");
    return saved === "light" || saved === "dark" ? saved : "";
  } catch {
    return "";
  }
}

const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const sans = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

const S: Record<string, React.CSSProperties> = {
  root: {
    // Fills whatever it is given rather than the old hardcoded 375×600, which left a strip
    // of the page's near-black background down the side of a 400px popup.
    width: "100%",
    height: "100%",
    minHeight: "100vh",
    boxSizing: "border-box",
    display: "flex",
    justifyContent: "center",
    overflowY: "auto",
    background: "var(--bg)",
    color: "var(--fg)",
    fontFamily: sans,
    padding: 20,
  },
  panel: {
    width: "100%",
    maxWidth: 340,
    margin: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  },
  mark: {
    width: 44,
    height: 44,
    lineHeight: "42px",
    border: "2px solid var(--fg)",
    color: "var(--fg)",
    fontFamily: mono,
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 16,
  },
  title: { margin: "0 0 10px", fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" },
  body: { margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--muted)" },
  attempt: {
    fontFamily: mono,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "-0.4px",
    color: "var(--muted)",
    border: "1px solid var(--border)",
    padding: "4px 10px",
    marginBottom: 16,
  },
  actions: { display: "flex", flexDirection: "column", gap: 8, width: "100%" },
  primary: {
    padding: "12px 16px",
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "var(--accent-fg)",
    fontFamily: mono,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "-0.6px",
    cursor: "pointer",
    borderRadius: 0,
  },
  secondary: {
    padding: "12px 16px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--fg)",
    fontFamily: mono,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "-0.6px",
    cursor: "pointer",
    borderRadius: 0,
  },
  confirm: { width: "100%", border: "1px solid var(--border)", padding: 14, textAlign: "left" },
  confirmTitle: { fontSize: 13, fontWeight: 800, marginBottom: 6 },
  confirmBody: { margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "var(--muted)" },
  detailsWrap: { display: "flex", gap: 16, marginTop: 18 },
  link: {
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--muted)",
    fontFamily: mono,
    fontSize: 11,
    letterSpacing: "-0.4px",
    textTransform: "uppercase",
    cursor: "pointer",
  },
  pre: {
    width: "100%",
    marginTop: 12,
    padding: 10,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--muted)",
    fontFamily: mono,
    fontSize: 10,
    lineHeight: 1.45,
    maxHeight: 180,
    overflow: "auto",
    textAlign: "left",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    boxSizing: "border-box",
  },
};

export default ErrorBoundary;
