/**
 * SkeletonLoaders.tsx — Reusable shimmer skeleton components for page transitions.
 *
 * Uses MUI <Skeleton> (wave animation built-in) so no extra CSS needed.
 * Each skeleton mirrors the actual page layout to prevent layout shift (CLS=0).
 *
 * Components:
 *  - PageSkeleton        → Generic route-level fallback (AppRouter Suspense)
 *  - HomePageSkeleton     → Balance card + token list shimmer
 *  - HistoryListSkeleton  → Transaction rows shimmer
 *  - PortfolioSkeleton    → Stat cards + charts + asset list shimmer
 *  - TokenListSkeleton    → Standalone token row list shimmer
 *  - NftGridSkeleton      → 2-column NFT card grid shimmer
 */

import { Box, Paper, Skeleton, Stack } from "@mui/material";

/* ─── Primitives ──────────────────────────────────── */

/** Single token/transaction row skeleton */
function RowSkeleton({ width = "100%" }: { width?: string }) {
  return (
    <Stack direction="row" spacing={2} alignItems="center" sx={{ py: 1.5, px: 1 }}>
      <Skeleton variant="circular" width={40} height={40} animation="wave" />
      <Box sx={{ flex: 1 }}>
        <Skeleton variant="text" width="55%" height={22} animation="wave" />
        <Skeleton variant="text" width="35%" height={16} animation="wave" />
      </Box>
      <Box sx={{ textAlign: "right" }}>
        <Skeleton variant="text" width={60} height={22} animation="wave" />
        <Skeleton variant="text" width={40} height={16} animation="wave" />
      </Box>
    </Stack>
  );
}

/** Stat card skeleton (Portfolio-style) */
function StatCardSkeleton() {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 3,
        borderRadius: 4,
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        height: "100%",
      }}
    >
      <Skeleton variant="text" width="50%" height={18} animation="wave" />
      <Skeleton variant="text" width="70%" height={36} animation="wave" sx={{ mt: 1 }} />
      <Skeleton variant="text" width="40%" height={14} animation="wave" sx={{ mt: 0.5 }} />
    </Paper>
  );
}

/* ─── Composites ──────────────────────────────────── */

/** Generic page-level skeleton — used as Suspense fallback in AppRouter */
export function PageSkeleton() {
  return (
    <Box sx={{ p: 3, pt: 4 }}>
      {/* Header area */}
      <Skeleton variant="text" width="40%" height={32} animation="wave" sx={{ mb: 2 }} />

      {/* Balance card placeholder */}
      <Paper
        elevation={0}
        sx={{
          p: 3,
          borderRadius: 4,
          background: "linear-gradient(45deg, rgba(37,99,235,0.12) 0%, rgba(239,246,255,0.05) 100%)",
          mb: 3,
        }}
      >
        <Skeleton variant="text" width="30%" height={18} animation="wave" />
        <Skeleton variant="text" width="50%" height={42} animation="wave" sx={{ mt: 1 }} />
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Skeleton variant="rounded" width={90} height={36} animation="wave" sx={{ borderRadius: 3 }} />
          <Skeleton variant="rounded" width={90} height={36} animation="wave" sx={{ borderRadius: 3 }} />
        </Stack>
      </Paper>

      {/* List rows */}
      {Array.from({ length: 5 }).map((_, i) => (
        <RowSkeleton key={i} />
      ))}
    </Box>
  );
}

/** Home page skeleton — mirrors balance card + token/nft tab list */
export function HomePageSkeleton() {
  return (
    <Box sx={{ pb: 10 }}>
      {/* Network switcher header */}
      <Box sx={{ px: 3, pt: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Skeleton variant="rounded" width={140} height={36} animation="wave" sx={{ borderRadius: 4 }} />
        <Skeleton variant="circular" width={36} height={36} animation="wave" />
      </Box>

      {/* Main balance card */}
      <Box sx={{ p: 3, pt: 2 }}>
        <Paper
          elevation={0}
          sx={{
            p: 3,
            borderRadius: 4,
            background: "linear-gradient(45deg, rgba(37,99,235,0.1) 20%, rgba(239,246,255,0.04) 80%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            mb: 2,
          }}
        >
          <Skeleton variant="text" width={80} height={18} animation="wave" />
          <Skeleton variant="text" width={160} height={48} animation="wave" sx={{ mt: 1 }} />
          <Skeleton variant="rounded" width={100} height={28} animation="wave" sx={{ mt: 1, borderRadius: 2 }} />
          <Stack direction="row" spacing={1.5} sx={{ mt: 3 }}>
            <Skeleton variant="rounded" width={100} height={36} animation="wave" sx={{ borderRadius: 3 }} />
            <Skeleton variant="rounded" width={100} height={36} animation="wave" sx={{ borderRadius: 3 }} />
          </Stack>
        </Paper>
      </Box>

      {/* Tab bar */}
      <Box sx={{ px: 2 }}>
        <Stack direction="row" spacing={3} sx={{ mb: 2 }}>
          <Skeleton variant="text" width={60} height={28} animation="wave" />
          <Skeleton variant="text" width={40} height={28} animation="wave" />
        </Stack>

        {/* Token rows */}
        {Array.from({ length: 6 }).map((_, i) => (
          <RowSkeleton key={i} />
        ))}
      </Box>
    </Box>
  );
}

/** History page skeleton — filter chips + transaction rows */
export function HistoryListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Box sx={{ p: 2 }}>
      {/* Filter chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Skeleton variant="rounded" width={50} height={28} animation="wave" sx={{ borderRadius: 3 }} />
        <Skeleton variant="rounded" width={90} height={28} animation="wave" sx={{ borderRadius: 3 }} />
        <Skeleton variant="rounded" width={60} height={28} animation="wave" sx={{ borderRadius: 3 }} />
      </Stack>

      {/* Transaction rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <Stack key={i} direction="row" spacing={2} alignItems="center" sx={{ py: 1.5 }}>
          <Skeleton variant="circular" width={40} height={40} animation="wave" />
          <Box sx={{ flex: 1 }}>
            <Skeleton variant="text" width="60%" height={24} animation="wave" />
            <Skeleton variant="text" width="40%" height={18} animation="wave" />
          </Box>
        </Stack>
      ))}
    </Box>
  );
}


/** Standalone token list skeleton (reusable in Home, Privacy, etc.) */
export function TokenListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Box>
      {Array.from({ length: rows }).map((_, i) => (
        <RowSkeleton key={i} />
      ))}
    </Box>
  );
}

