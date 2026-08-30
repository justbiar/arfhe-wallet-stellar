/**
 * HuntMark — the mascot that hides a fragment of the treasure-hunt phrase.
 *
 * Three of these sit in the wallet, one on each of three screens. Tapping one reveals the
 * words it carries; tapping again hides them. Nothing is fetched, nothing is stored, and
 * the text is a plain literal in the calling page — the hunt is meant to be findable, so
 * there is no point pretending otherwise.
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

import { useState } from "react";
import { Box, Fade, Tooltip, Typography, alpha, useTheme } from "@mui/material";

/**
 * Where the mascot image lives.
 *
 * Dropped into `public/`, so it is copied to the extension root untouched. If the file is
 * missing the component still works — the fallback below keeps the mark visible rather
 * than leaving an invisible click target nobody can find.
 */
const MASCOT_SRC = "/mascot.png";

/** The mascot's own background, kept behind it so the mark reads the same in both themes. */
const MASCOT_GROUND = "#0D0F12";

interface HuntMarkProps {
  /** What appears when the mark is tapped, e.g. "1. bind   2. life". */
  reveal: string;
  /** Hover hint. Keep it playful and free of wallet-recovery vocabulary. */
  hint?: string;
  size?: number;
  /**
   * Show this mark only in one colour mode.
   *
   * A mark that appears only in the dark is a second thing to notice — the wallet has a
   * theme toggle, and someone who never touches it never sees this one. Absent from the
   * DOM rather than merely transparent, so an inspector in the wrong mode finds nothing
   * to be curious about either.
   *
   * It hides the mark, not the fragment: the text is still a literal in this bundle, and
   * anyone reading the source has it regardless. That is the honest limit of the trick,
   * and the reason it is a flourish rather than a difficulty setting.
   */
  onlyIn?: "dark" | "light";
}

export default function HuntMark({ reveal, hint = "?", size = 34, onlyIn }: HuntMarkProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  if (onlyIn && theme.palette.mode !== onlyIn) return null;

  return (
    <Box sx={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 0.75 }}>
      <Tooltip title={hint} arrow>
        <Box
          component="button"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={hint}
          sx={{
            width: size,
            height: size,
            p: 0.5,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            // Square and bordered, like everything else in this design system.
            borderRadius: 0,
            border: "1px solid",
            borderColor: open ? "primary.main" : "divider",
            // The tile carries the mascot's own dark ground in both themes, so the bird
            // looks identical wherever it appears. It is white line art: on the bone
            // light surface it would otherwise be a blank square, and tinting it to suit
            // the theme would mean changing the mark itself.
            bgcolor: MASCOT_GROUND,
            transition: "border-color .15s ease",
            "&:hover": { borderColor: "text.primary" },
          }}
        >
          {broken ? (
            // The mascot file is not there. Still clickable, still findable.
            <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: size * 0.5, lineHeight: 1, color: "#F2F0E9" }}>
              ᚹ
            </Typography>
          ) : (
            <Box
              component="img"
              src={MASCOT_SRC}
              alt=""
              onError={() => setBroken(true)}
              // `contain`, and no filter of any kind: the mark ships as the artwork was
              // drawn, at its own aspect ratio.
              sx={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          )}
        </Box>
      </Tooltip>

      <Fade in={open} unmountOnExit>
        <Typography
          sx={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "-0.4px",
            textTransform: "none",
            px: 1,
            py: 0.4,
            border: "1px solid",
            borderColor: "divider",
            bgcolor: "background.default",
            whiteSpace: "nowrap",
          }}
        >
          {reveal}
        </Typography>
      </Fade>
    </Box>
  );
}
