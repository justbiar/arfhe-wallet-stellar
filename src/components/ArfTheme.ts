/**
 * ArfTheme — Max Yinger (Midnight Terminal) Design System
 * Added Light Mode support by inverting Midnight Carbon and Bone Glow.
 */

import { createTheme, type PaletteMode } from "@mui/material";

const baseTokens = {
  typography: {
    fontFamily: "var(--font-arbeit-contrast)", // Inter
    fontFamilyMono: "var(--font-arbeit-technik)", // JetBrains Mono
    fontFamilyDisplay: "var(--font-inline-vf)", // VT323
  },
};

const typography = {
  fontFamily: baseTokens.typography.fontFamily,
  h1: { fontFamily: baseTokens.typography.fontFamilyDisplay, fontSize: "80px", lineHeight: 0.70, fontWeight: 400 },
  h2: { fontFamily: baseTokens.typography.fontFamilyDisplay, fontSize: "60px", lineHeight: 0.80, fontWeight: 400 },
  h3: { fontSize: "30px", lineHeight: 1.13, fontWeight: 400 },
  h4: { fontSize: "24px", lineHeight: 1.25, fontWeight: 400 },
  h5: { fontSize: "20px", lineHeight: 1.25, fontWeight: 400 },
  h6: { fontSize: "18px", lineHeight: 1.25, fontWeight: 400 },
  subtitle1: { fontSize: "16px", lineHeight: 1.25, fontWeight: 400 },
  subtitle2: { fontSize: "14px", lineHeight: 1.25, fontWeight: 400 },
  body1: { fontSize: "16px", lineHeight: 1.25, fontWeight: 400 },
  body2: { fontSize: "14px", lineHeight: 1.25, fontWeight: 400 },
  caption: { fontFamily: baseTokens.typography.fontFamilyMono, fontSize: "12px", lineHeight: 1.25, letterSpacing: "-0.6px", textTransform: "uppercase" as const },
  button: { fontFamily: baseTokens.typography.fontFamilyMono, fontSize: "12px", letterSpacing: "-0.6px", textTransform: "none" as const },
};

function getTokensForMode(mode: PaletteMode) {
  if (mode === "light") {
    return {
      bg: "#F2F0E9", // A slightly warmer, richer paper background
      fg: "#0D0D0D", // Pitch black text
      fgMuted: "#5C5C58", // Readable secondary text (distinct from border)
      border: "#D1D1D1", // Crisp borders
      accent: "#4338CA", // Vibrant Indigo for light mode
      accentHover: "#3730A3"
    };
  }
  return {
    bg: "#0D0F12", // Deep space dark blue/black
    fg: "#F2F0E9", // Bone white text
    fgMuted: "#9A9FA6", // Readable secondary text (distinct from border)
    border: "#2A2E35", // Clean dark borders
    accent: "#00E676", // Vibrant Neon Mint for dark mode!
    accentHover: "#00C853"
  };
}

function getComponents(mode: PaletteMode) {
  const t = getTokensForMode(mode);

  return {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: t.bg,
          color: t.fg,
        },
        "*": {
          boxSizing: "border-box",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: "0px", // Updated to sharp edges
          textTransform: "uppercase" as const,
          fontWeight: 700,
          letterSpacing: "0.05em",
          padding: "12px 20px",
          boxShadow: "none",
          "&:hover": {
            boxShadow: "none",
          },
        },
        contained: {
          backgroundColor: t.accent,
          color: mode === 'dark' ? '#000000' : '#ffffff',
          border: `1px solid ${t.accent}`,
          "&:hover": {
            backgroundColor: t.accentHover,
            borderColor: t.accentHover,
          },
          "&.Mui-disabled": {
            backgroundColor: t.border,
            color: t.bg,
            borderColor: t.border,
          },
        },
        outlined: {
          background: "transparent",
          color: t.fg,
          border: `1px solid ${t.border}`,
          "&:hover": {
            background: "transparent",
            borderColor: t.fg,
          },
          "&.Mui-disabled": {
            color: t.border,
            borderColor: t.border,
          },
        },
        text: {
          color: t.fg,
          "&:hover": {
            background: "transparent",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: t.bg,
          border: `1px solid ${t.border}`,
          boxShadow: "none",
          borderRadius: "0px",
        },
      },
    },
    MuiBottomNavigation: {
      styleOverrides: {
        root: {
          backgroundColor: t.bg,
          borderTop: "none",
        },
      },
    },
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          color: t.border,
          "&.Mui-selected": {
            color: t.fg,
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: "0px",
          backgroundColor: t.bg,
          border: `1px solid ${t.border}`,
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            borderRadius: "0px",
            "& fieldset": {
              borderColor: t.border,
            },
            "&:hover fieldset": {
              borderColor: t.fg,
            },
            "&.Mui-focused fieldset": {
              borderColor: t.fg,
              borderWidth: 1,
            },
          },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: "0px",
          backgroundColor: t.bg,
          border: `1px solid ${t.border}`,
          color: t.fg,
          fontFamily: baseTokens.typography.fontFamilyMono,
          fontSize: "12px",
          letterSpacing: "-0.6px",
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: "0px",
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: t.border,
        },
      },
    },
  };
}

export const getTheme = (mode: PaletteMode) => {
  const t = getTokensForMode(mode);

  return createTheme({
    palette: {
      mode,
      primary: {
        main: t.accent,
        contrastText: mode === 'dark' ? '#000000' : '#ffffff',
      },
      secondary: {
        main: t.fg,
      },
      background: {
        default: t.bg,
        paper: t.bg,
      },
      text: {
        primary: t.fg,
        secondary: t.fgMuted,
        disabled: t.border,
      },
      divider: t.border,
    },
    typography,
    shape: { borderRadius: 0 },
    components: getComponents(mode),
  });
};

export default getTheme;