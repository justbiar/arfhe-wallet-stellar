/**
 * HuntMark — the mascot that stands where a fragment of the hunt phrase can be earned.
 *
 * It carries no words. Tapping it asks the server, which answers only if this account has
 * done whatever that fragment requires. The previous version held the words as literals in
 * this file; someone fed the built folder to a language model and read all of them out in
 * under a minute, which is what any bundle will always allow — it is a recipe for what it
 * shows, and a machine can follow a recipe as easily as run it.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never renders the word "seed", "phrase" or any wallet-recovery language, and it
 *    never asks for input. A wallet that teaches people to hunt for recovery words is one
 *    whose users can be phished with a convincing imitation of this exact game, and the
 *    least this component can do is not supply the vocabulary for it.
 *  - It is not hidden from assistive technology. A screen-reader user gets the same label
 *    and the same revealed text as everyone else; an easter egg that is invisible to them
 *    is an easter egg they are excluded from, not a harder puzzle.
 */

import { useCallback, useContext, useState } from "react";
import { Box, CircularProgress, Fade, Tooltip, Typography, useTheme } from "@mui/material";

import { WalletContext } from "../AppContext";
import { claimFragment, type FragmentResult } from "../backend/HuntService";

const MASCOT_SRC = "/mascot.png";

/** The mascot's own background, kept behind it so the mark reads the same in both themes. */
const MASCOT_GROUND = "#0D0F12";

interface HuntMarkProps {
  /** Which fragment this mark stands for. An id only — the words live on the server. */
  fragmentId: string;
  /** Hover hint. Keep it playful and free of wallet-recovery vocabulary. */
  hint?: string;
  size?: number;
  /**
   * Show this mark only in one colour mode.
   *
   * A mark that appears only in the dark is a second thing to notice — the wallet has a
   * theme toggle, and someone who never touches it never sees this one.
   */
  onlyIn?: "dark" | "light";
}

export default function HuntMark({ fragmentId, hint = "?", size = 34, onlyIn }: HuntMarkProps) {
  const theme = useTheme();
  const context = useContext(WalletContext);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FragmentResult | null>(null);

  const onClick = useCallback(async () => {
    // Second tap closes it, so a revealed fragment is not stuck on screen.
    if (result) { setResult(null); return; }
    if (busy) return;

    setBusy(true);
    try {
      setResult(await claimFragment(fragmentId, context?.accountManager?.GetActive()));
    } finally {
      setBusy(false);
    }
  }, [busy, context, fragmentId, result]);

  if (onlyIn && theme.palette.mode !== onlyIn) return null;

  const open = result !== null;
  const revealed = result?.status === "revealed";

  return (
    <Box
      sx={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        // Same reason as HuntSurface: revealed, this column is as wide as the panel, and a
        // transparent 260px rectangle that eats taps is indistinguishable from a frozen
        // screen. The mark and the panel take clicks; the space between and around them
        // belongs to whatever is underneath.
        pointerEvents: "none",
      }}
    >
      <Tooltip title={hint} arrow>
        <Box
          component="button"
          type="button"
          onClick={onClick}
          aria-expanded={open}
          aria-busy={busy}
          aria-label={hint}
          sx={{
            width: size,
            height: size,
            p: 0.5,
            cursor: busy ? "wait" : "pointer",
            display: "grid",
            placeItems: "center",
            borderRadius: 0,
            border: "1px solid",
            borderColor: revealed ? "primary.main" : "divider",
            // The tile carries the mascot's own dark ground in both themes, so the bird
            // looks identical wherever it appears. It is white line art: on the bone light
            // surface it would otherwise be a blank square.
            bgcolor: MASCOT_GROUND,
            transition: "border-color .15s ease",
            pointerEvents: "auto",
            "&:hover": { borderColor: "text.primary" },
          }}
        >
          {busy ? (
            <CircularProgress size={size * 0.45} sx={{ color: "#F2F0E9" }} />
          ) : broken ? (
            <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: size * 0.5, lineHeight: 1, color: "#F2F0E9" }}>
              ᚹ
            </Typography>
          ) : (
            <Box
              component="img"
              src={MASCOT_SRC}
              alt=""
              onError={() => setBroken(true)}
              sx={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          )}
        </Box>
      </Tooltip>

      <Fade in={open} unmountOnExit>
        <Box
          sx={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "-0.4px",
            textTransform: "none",
            px: 1,
            py: 0.4,
            border: "1px solid",
            // A locked mark reads as a hint, not an error: the user has found the right
            // place and has not yet done the thing. Colouring it like a failure would tell
            // them to give up on the one screen where they are closest.
            borderColor: revealed ? "primary.main" : "divider",
            color: revealed ? "text.primary" : "text.secondary",
            bgcolor: "background.default",
            maxWidth: 260,
            textAlign: "center",
            // The panel is readable and selectable — a word you cannot copy is a word you
            // have to transcribe by eye, which is how a phrase gets written down wrong.
            pointerEvents: "auto",
          }}
        >
          {/* Where this word sits, above the word itself.
              Without it the finder is holding an unordered pile: the same words in a
              different order open nothing, and nothing on screen says which one this is.
              Rendered as its own line rather than prefixed onto the word, so selecting the
              word copies the word and not "3 / 24 rigid". */}
          {result?.status === "revealed" && result.index !== undefined && (
            <Box
              component="span"
              sx={{
                display: "block",
                fontSize: 10,
                letterSpacing: "0.08em",
                color: "text.secondary",
                mb: 0.25,
              }}
            >
              {result.total !== undefined ? `${result.index} / ${result.total}` : String(result.index)}
            </Box>
          )}
          <Box component="span" sx={{ display: "block", userSelect: "text" }}>
            {result?.status === "revealed" ? result.words : result?.reason}
          </Box>
        </Box>
      </Fade>
    </Box>
  );
}
