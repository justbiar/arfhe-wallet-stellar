import { pt, usePanelLanguage } from "../lib/language";
/**
 * Page chrome shared by every route: the top bar, and the width the content sits in.
 *
 * Deliberately thin. The panel is a handful of pages with no navigation state worth
 * centralising, so this holds the header and gets out of the way rather than becoming a
 * layout framework.
 */
import { Box, Stack, Typography, Button, IconButton, Tooltip, useTheme, alpha } from "@mui/material";
import LightModeIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeIcon from "@mui/icons-material/DarkModeOutlined";
import { Link, useLocation } from "react-router";
import { CHROME_STORE_URL } from "../lib/product";

const NAV = [
  { to: "/", label: "Ana Sayfa" },
  { to: "/roadmap", label: "Yol Haritası" },
  { to: "/bridge", label: "Köprü" },
  { to: "/payroll", label: "Gizli Ödeme" },
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
  const { language, setLanguage } = usePanelLanguage();
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
          sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, minHeight: 76, py: 1.5, gap: 1.5, flexWrap: "wrap" }}
        >
          <Stack component={Link} to="/" direction="row" alignItems="center" gap={1.2}
            sx={{ textDecoration: "none", color: "text.primary", flexShrink: 0 }}>
            <Box component="img" src="/Arfhe-logo.png" alt="" sx={{ width: 26, height: 26, filter: mode === "dark" ? "invert(1)" : "none" }} />
            <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontWeight: 700, letterSpacing: "0.06em", fontSize: 14 }}>{pt(" ARFHE ")}</Typography>
          </Stack>

          <Stack component="nav" aria-label={pt("Ana menü")} direction="row" gap={0.5} sx={{ flex: { xs: "1 0 100%", lg: 1 }, order: { xs: 3, lg: 0 }, overflowX: "auto", minWidth: 0, pb: { xs: 0.5, lg: 0 } }}>
            {NAV.map((item) => {
              const active = pathname === item.to;
              return (
                <Button
                  key={item.to}
                  component={Link}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  disableRipple
                  sx={{
                    px: 1.5,
                    borderRadius: "10px",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    minHeight: 42,
                    bgcolor: active ? "action.selected" : "transparent",
                    color: active ? "text.primary" : "text.secondary",
                    fontWeight: active ? 700 : 500,
                    borderBottom: "2px solid",
                    borderColor: "transparent",
                    "&:hover": { bgcolor: "transparent", color: "text.primary" },
                  }}
                >
                  {pt(item.label)}
                </Button>
              );
            })}
          </Stack>

          <Box sx={{ ml: "auto", flexShrink: 0 }}>
            <Box component="select" aria-label="Language / Dil" value={language}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setLanguage(event.target.value === "tr" ? "tr" : "en")}
              sx={{ minHeight: 42, px: 1.5, border: "1px solid", borderColor: "divider", borderRadius: "10px", bgcolor: "background.paper", color: "text.primary", font: "inherit", fontSize: 13, cursor: "pointer" }}>
              <option value="en">English</option>
              <option value="tr">Türkçe</option>
            </Box>
          </Box>

          <Button
            href={CHROME_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="contained"
            size="small"
            sx={{ borderRadius: "10px", minHeight: 42, px: 1.8, py: 0.7, fontSize: 11, fontWeight: 700, flexShrink: 0, display: { xs: "none", sm: "inline-flex" } }}
          >{pt(" Chrome'a ekle ")}</Button>

          <Tooltip title={pt(mode === "light" ? "Koyu tema" : "Açık tema")}>
            <IconButton aria-label={pt(mode === "light" ? "Koyu tema" : "Açık tema")} onClick={onToggleMode} size="small" sx={{ color: "text.secondary" }}>
              {mode === "light" ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      <Box component="main" sx={{ flex: 1 }}>{pt(children)}</Box>

      <Box component="footer" sx={{ borderTop: "1px solid", borderColor: "divider", py: 3 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          gap={1}
          sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, alignItems: { sm: "center" } }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, textTransform: "none" }}>{pt(" Stellar testnet demosu. Gerçek para, gerçek banka ve gerçek KYC yoktur. ")}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>{pt(" ArfDAO ")}</Typography>
        </Stack>
      </Box>
    </Box>
  );
}
