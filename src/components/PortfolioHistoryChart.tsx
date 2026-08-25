/**
 * PortfolioHistoryChart — the wallet's recorded totals, and nothing else.
 *
 * Its predecessor drew a random walk backwards from today's balance. This one plots only
 * points that were observed and stored, which means it is often nearly empty, and that is
 * the honest state rather than a defect to paper over:
 *
 *  - no points at all → say the record has not started
 *  - one point        → a single observation is not a trend; show the value, not a line
 *  - a gap in usage   → the line simply spans it, because nothing was measured in between
 *
 * Ranges filter the same series; they never synthesise points to fill a window.
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Button, Stack, Typography, useTheme, alpha } from "@mui/material";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PortfolioPoint, HistoryRange } from "../backend/PortfolioHistoryService.js";

interface Props {
  points: PortfolioPoint[];
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
  /** Blur the figures when the user has hidden balances. */
  hidden?: boolean;
}

const RANGES: HistoryRange[] = ["1D", "1W", "1M", "ALL"];

export default function PortfolioHistoryChart({ points, range, onRangeChange, hidden }: Props) {
  const theme = useTheme();
  const { t } = useTranslation();

  const data = useMemo(
    () =>
      points.map((p) => ({
        t: p.t,
        usd: p.usd,
        label: new Date(p.t).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    [points]
  );

  // The axis is scaled to the observed span, not to zero: a wallet whose value moved by a
  // few percent would otherwise render as a flat line against a large baseline.
  const [min, max] = useMemo(() => {
    if (data.length === 0) return [0, 1];
    const values = data.map((d) => d.usd);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo) * 0.1 || Math.max(hi * 0.05, 1);
    return [Math.max(0, lo - pad), hi + pad];
  }, [data]);

  const rangeButtons = (
    <Stack direction="row" spacing={0.5}>
      {RANGES.map((r) => (
        <Button
          key={r}
          size="small"
          onClick={() => onRangeChange(r)}
          sx={{
            minWidth: 0,
            px: 1,
            py: 0.25,
            borderRadius: "0px",
            fontSize: "0.68rem",
            fontWeight: 700,
            color: r === range ? "text.primary" : "text.disabled",
            borderBottom: "2px solid",
            borderColor: r === range ? "text.primary" : "transparent",
          }}
        >
          {r === "ALL" ? t("portfolio.rangeAll") : r}
        </Button>
      ))}
    </Stack>
  );

  if (data.length === 0) {
    return (
      <Box sx={{ py: 3, textAlign: "center" }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {t("portfolio.historyEmpty")}
        </Typography>
      </Box>
    );
  }

  if (data.length === 1) {
    // One observation. Drawing a line through a single point would imply a flat history
    // the wallet never actually watched.
    return (
      <Box>
        <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>{rangeButtons}</Stack>
        <Box sx={{ py: 2, textAlign: "center" }}>
          <Typography variant="caption" color="text.secondary">
            {t("portfolio.historySinglePoint", {
              when: new Date(data[0].t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            })}
          </Typography>
        </Box>
      </Box>
    );
  }

  const rising = data[data.length - 1].usd >= data[0].usd;
  const stroke = rising ? theme.palette.success.main : theme.palette.error.main;

  return (
    <Box>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>{rangeButtons}</Stack>
      <Box sx={{ height: 140, filter: hidden ? "blur(6px)" : "none" }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="portfolioFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              // Spaced by actual time, so a gap in usage reads as a gap rather than being
              // squeezed into an evenly-spaced series that implies steady observation.
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v: number) => formatTick(v, range)}
              tick={{ fontSize: 10, fill: theme.palette.text.disabled }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis domain={[min, max]} hide />
            <Tooltip
              contentStyle={{
                borderRadius: 0,
                border: `1px solid ${theme.palette.divider}`,
                background: theme.palette.background.paper,
                fontSize: 12,
              }}
              labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
              formatter={(value: number) => [
                `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                t("portfolio.total"),
              ]}
            />
            <Area
              type="monotone"
              dataKey="usd"
              stroke={stroke}
              strokeWidth={2}
              fill="url(#portfolioFill)"
              dot={data.length < 12 ? { r: 2, fill: stroke } : false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Box>
      <Typography variant="caption" color="text.disabled" sx={{ display: "block", textAlign: "center", mt: 0.5 }}>
        {t("portfolio.pointCount", { count: data.length })}
      </Typography>
    </Box>
  );
}

/** Axis labels: time of day over a day, dates over longer ranges. */
function formatTick(ms: number, range: HistoryRange): string {
  const d = new Date(ms);
  if (range === "1D") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The daily-change badge, shown wherever a total is.
 *
 * Renders nothing without a baseline. A wallet opened for the first time has one
 * observation, and "0.00% today" would be a claim about a day nobody watched.
 */
export function DailyChangeBadge({
  absolute,
  percent,
  hasBaseline,
  hidden,
  compact,
}: {
  absolute: number;
  percent: number;
  hasBaseline: boolean;
  hidden?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();

  if (!hasBaseline) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ fontSize: compact ? "0.65rem" : "0.7rem" }}>
        {t("portfolio.noBaseline")}
      </Typography>
    );
  }

  if (hidden) {
    return <Typography variant="caption" color="text.disabled">•••</Typography>;
  }

  const up = absolute >= 0;
  const color = up ? theme.palette.success.main : theme.palette.error.main;
  const sign = up ? "+" : "−";
  const amount = Math.abs(absolute).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{
        px: 0.75,
        py: 0.25,
        bgcolor: alpha(color, 0.1),
        border: "1px solid",
        borderColor: alpha(color, 0.3),
      }}
    >
      {/* Both figures, because neither answers the question alone: a percentage hides how
          much money moved, and an amount hides whether that was a lot. */}
      <Typography variant="caption" sx={{ color, fontWeight: 700, fontSize: compact ? "0.65rem" : "0.72rem" }}>
        {sign}${amount}
      </Typography>
      <Typography variant="caption" sx={{ color, fontWeight: 700, fontSize: compact ? "0.65rem" : "0.72rem", opacity: 0.85 }}>
        ({sign}{Math.abs(percent).toFixed(2)}%)
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ fontSize: compact ? "0.6rem" : "0.65rem" }}>
        {t("portfolio.today")}
      </Typography>
    </Stack>
  );
}
