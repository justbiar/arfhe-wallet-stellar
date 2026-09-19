import { pt } from "../lib/language";
/**
 * The frame both panes sit in — a titled surface with a consistent header row.
 *
 * Shared so the two sides line up pixel for pixel; everything inside is free to look like
 * whatever product it represents.
 */
import { Box, Paper, Stack, Typography } from "@mui/material";

export default function PaneFrame({
  label,
  title,
  accent,
  surface,
  children,
}: {
  label: string;
  title: React.ReactNode;
  accent: string;
  /** Background for the pane body, so a bank can look like a bank. */
  surface?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper
      elevation={0}
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 3,
        bgcolor: surface ?? "background.paper",
        display: "flex",
        flexDirection: "column",
        minHeight: { xs: 0, md: 460 },
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        gap={1.2}
        sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Box sx={{ width: 8, height: 8, bgcolor: accent, flexShrink: 0 }} />
        <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
          {pt(label)}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {pt(title)}
      </Stack>
      <Box sx={{ p: { xs: 2, md: 2.5 }, flex: 1 }}>{pt(children)}</Box>
    </Paper>
  );
}
