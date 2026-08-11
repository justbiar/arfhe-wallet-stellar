/**
 * NftGalleryCard.tsx
 *
 * Premium NFT card for the Home screen gallery grid.
 *
 * Features:
 * - Fetches tokenURI(0) via direct RPC eth_call and resolves metadata JSON
 * - Renders image (lazy-loaded) or video (autoplay/muted/loop)
 * - Artwork and token id come from the indexer; nothing here guesses at a token
 * - IPFS gateway passthrough (ipfs:// → cloudflare-ipfs.com)
 * - Hover lift + shadow animation
 * - Bottom info strip: name, symbol, balance
 */

import React, { useState } from "react";
import {
    Box,
    Typography,
    Chip,
    alpha,
} from "@mui/material";
import { BrokenImage, Shield } from "@mui/icons-material";

// ------------------------------------------------------------------
// IPFS helper
// ------------------------------------------------------------------
function resolveIpfs(url: string): string {
    if (!url) return "";
    if (url.startsWith("ipfs://")) {
        return url.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
    }
    return url;
}

// ------------------------------------------------------------------
// Media renderer (image or video)
// ------------------------------------------------------------------
function NftMedia({ src, name }: { src: string; name: string }) {
    const [errored, setErrored] = useState(false);
    const isVideo =
        src.endsWith(".mp4") ||
        src.endsWith(".webm") ||
        src.endsWith(".mov") ||
        src.includes("video");

    if (!src || errored) {
        return (
            <Box
                sx={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "linear-gradient(135deg, #f5f5f5 0%, #e5e5e5 100%)",
                    borderRadius: "inherit",
                }}
            >
                <BrokenImage sx={{ fontSize: 36, color: "text.disabled" }} />
            </Box>
        );
    }

    if (isVideo) {
        return (
            <video
                src={src}
                autoPlay
                muted
                loop
                playsInline
                style={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    objectFit: "cover",
                    borderRadius: "inherit",
                    display: "block",
                }}
                onError={() => setErrored(true)}
            />
        );
    }

    return (
        <Box
            component="img"
            src={src}
            alt={name}
            loading="lazy"
            onError={() => setErrored(true)}
            sx={{
                width: "100%",
                aspectRatio: "1 / 1",
                objectFit: "cover",
                borderRadius: "inherit",
                display: "block",
                transition: "transform 0.4s ease",
                "&:hover": { transform: "scale(1.04)" },
            }}
        />
    );
}

// ------------------------------------------------------------------
// Main card component
// ------------------------------------------------------------------
interface NftGalleryCardProps {
    contractAddress: string;
    /** Which token this card is. Required to show the right art and to link to it. */
    tokenId: string;
    symbol: string;
    name: string;
    /** Already-resolved artwork URL. */
    imageUrl?: string;
    balance?: number;
    isShielded?: boolean;
    /** Marketplace link base for the active chain; omitted when there is none. */
    marketplaceUrl?: string;
}

export default function NftGalleryCard({
    contractAddress,
    tokenId,
    symbol,
    name,
    imageUrl = "",
    balance = 1,
    isShielded = false,
    marketplaceUrl,
}: NftGalleryCardProps) {
    const displayName = name || symbol || `#${tokenId}`;

    /** Open the item on a marketplace. Nothing happens when the chain has none. */
    const openMarketplace = () => {
        if (!marketplaceUrl) return;
        window.open(marketplaceUrl, "_blank", "noopener,noreferrer");
    };

    return (
        <Box
            onClick={openMarketplace}
            role={marketplaceUrl ? "link" : undefined}
            tabIndex={marketplaceUrl ? 0 : undefined}
            onKeyDown={(e) => { if (marketplaceUrl && (e.key === "Enter" || e.key === " ")) openMarketplace(); }}
            aria-label={marketplaceUrl ? `${displayName} — view on marketplace` : undefined}
            sx={{
                borderRadius: 3,
                overflow: "hidden",
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                position: "relative",
                // Only offer the affordance when there is somewhere to go. A card that
                // looks clickable and does nothing is worse than a plain one.
                cursor: marketplaceUrl ? "pointer" : "default",
                transition: "transform 0.22s ease, box-shadow 0.22s ease",
                "&:hover": {
                    transform: "translateY(-4px)",
                    boxShadow: (theme) =>
                        `0 12px 28px -8px ${alpha(theme.palette.primary.main, 0.25)}`,
                },
                "&:active": {
                    transform: "translateY(-2px) scale(0.985)",
                },
            }}
        >
            {/* Media area */}
            <Box sx={{ overflow: "hidden", borderRadius: "inherit" }}>
                <NftMedia src={imageUrl} name={displayName} />
            </Box>

            {/* Shield badge */}
            {isShielded && (
                <Box
                    sx={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        bgcolor: "#10b981",
                        borderRadius: "50%",
                        width: 22,
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 2px 6px rgba(16,185,129,0.4)",
                    }}
                >
                    <Shield sx={{ fontSize: 12, color: "#fff" }} />
                </Box>
            )}

            {/* Info strip */}
            <Box sx={{ p: 1.25 }}>
                <Typography
                    variant="body2"
                    fontWeight={700}
                    noWrap
                    sx={{ lineHeight: 1.3, color: "text.primary", fontSize: "0.82rem" }}
                >
                    {displayName}
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mt: 0.5 }}>
                    <Typography
                        variant="caption"
                        sx={{ color: "text.secondary", fontFamily: "monospace", fontSize: "0.65rem" }}
                    >
                        {contractAddress.slice(0, 6)}…{contractAddress.slice(-4)}
                    </Typography>
                    <Chip
                        label={`×${balance}`}
                        size="small"
                        sx={{
                            height: 17,
                            fontSize: "0.62rem",
                            fontWeight: 700,
                            bgcolor: "action.hover",
                            color: "text.secondary",
                            "& .MuiChip-label": { px: 0.75 },
                        }}
                    />
                </Box>
            </Box>
        </Box>
    );
}
