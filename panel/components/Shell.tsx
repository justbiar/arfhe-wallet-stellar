/**
 * Page chrome shared by every route: the top bar, and the width the content sits in.
 *
 * Deliberately thin. The panel has three pages and no navigation state worth centralising,
 * so this holds the header and gets out of the way rather than becoming a layout framework.
 */
import { Box, Stack, Typography, Button, IconButton, Tooltip, useTheme, alpha } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeIcon from "@mui/icons-material/DarkModeOutlined";
import { Link, useLocation } from "react-router";
import { CHROME_STORE_URL } from "../lib/product";

const NAV = [
  { to: "/", label: "Ana Sayfa" },
  { to: "/bridge", label: "Köprü" },
  { to: "/privacy", label: "Gizlilik Havuzu" },
  { to: "/anchor", label: "Confidential Anchor" },
  { to: "/about", label: "Arfhe Wallet" },
];

export default function Shell({
  children,
  mode,
  onToggleMode,
}: {
  children: React.ReactNode;
  mode: "light" | "dark";
  onToggleMode: () => void;
}) {
  const theme = useTheme();
  const { pathname } = useLocation();

  return (
    <Box sx={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <Box
        component="header"
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: alpha(theme.palette.background.default, 0.88),
          backdropFilter: "blur(8px)",
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, height: 60, gap: 3 }}
        >
          <Stack component={Link} to="/" direction="row" alignItems="center" gap={1.2}
            sx={{ textDecoration: "none", color: "text.primary", flexShrink: 0 }}>
            <Box component="img" src="/Arfhe-logo.png" alt="" sx={{ width: 26, height: 26 }} />
            <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontWeight: 700, letterSpacing: "0.06em", fontSize: 14 }}>
              ARFHE
            </Typography>
          </Stack>

          <Stack direction="row" gap={0.5} sx={{ flex: 1 }}>
            {NAV.map((item) => {
              const active = pathname === item.to;
              return (
                <Button
                  key={item.to}
                  component={Link}
                  to={item.to}
                  disableRipple
                  sx={{
                    px: 1.5,
                    borderRadius: 0,
                    color: active ? "text.primary" : "text.secondary",
                    fontWeight: active ? 700 : 500,
                    borderBottom: "2px solid",
                    borderColor: active ? "text.primary" : "transparent",
                    "&:hover": { bgcolor: "transparent", color: "text.primary" },
                  }}
                >
                  {item.label}
                </Button>
              );
            })}
          </Stack>

          <Button
            href={CHROME_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="contained"
            size="small"
            sx={{ borderRadius: 0, px: 1.8, py: 0.7, fontSize: 11, fontWeight: 700, flexShrink: 0, display: { xs: "none", sm: "inline-flex" } }}
          >
            Chrome'a ekle
          </Button>

          <Tooltip title={mode === "light" ? "Koyu tema" : "Açık tema"}>
            <IconButton onClick={onToggleMode} size="small" sx={{ color: "text.secondary" }}>
              {mode === "light" ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      <Box component="main" sx={{ flex: 1 }}>{children}</Box>

      <Box component="footer" sx={{ borderTop: "1px solid", borderColor: "divider", py: 3 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          gap={1}
          sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, alignItems: { sm: "center" } }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, textTransform: "none" }}>
            Stellar testnet demosu. Gerçek para, gerçek banka ve gerçek KYC yoktur.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
            ArfDAO
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
}
