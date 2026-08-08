import { useNavigate } from "react-router";
import { Box, Typography } from "@mui/material";
import { useEffect } from "react";

// Precise geometry of the ring nested in the sigma mark's notch, measured
// from public/Arfhe-logo.png (377x369): center ~(83.8%, 48.8%), outer
// diameter ~23.3% of the logo's width, stroke ~2.9% of the logo's width.
const LOGO_SIZE = 150; // px, displayed square-ish (image is 377x369)
const RING_LEFT_PCT = 83.8;
const RING_TOP_PCT = 48.8;
const RING_DIAMETER = LOGO_SIZE * 0.233;
const RING_STROKE = Math.max(3, LOGO_SIZE * 0.029);

function Splash() {
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => {
      navigate("auth");
    }, 3000);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <Box sx={{
      height: '100%',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      background: 'var(--surface-canvas)',
      position: 'relative',
      overflow: 'hidden'
    }}>

      {/* Sigma mark with animated ring → coin */}
      <Box sx={{
        position: 'relative',
        width: LOGO_SIZE,
        height: LOGO_SIZE * (369 / 377),
        mb: 3,
      }}>
        <Box
          component="img"
          src="/Arfhe-logo.png"
          alt="Arfhe"
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            // Logo ships with a dark stroke; invert so it reads as
            // "bone glow" on the dark splash background.
            filter: 'invert(1) brightness(1.05)',
            display: 'block',
          }}
        />

        {/* Mask: covers the logo's static ring right as the decoy ring falls away */}
        <Box sx={{
          position: 'absolute',
          left: `${RING_LEFT_PCT}%`,
          top: `${RING_TOP_PCT}%`,
          width: RING_DIAMETER + 6,
          height: RING_DIAMETER + 6,
          borderRadius: '50%',
          bgcolor: 'var(--surface-canvas)',
          opacity: 0,
          animation: 'arfheMaskReveal 0.01s steps(1) 0.6s forwards',
          '@keyframes arfheMaskReveal': {
            from: { opacity: 0 },
            to: { opacity: 1 },
          },
        }} />

        {/* Decoy ring: identical to the logo's ring, falls away to reveal the mask */}
        <Box sx={{
          position: 'absolute',
          left: `${RING_LEFT_PCT}%`,
          top: `${RING_TOP_PCT}%`,
          width: RING_DIAMETER,
          height: RING_DIAMETER,
          borderRadius: '50%',
          border: `${RING_STROKE}px solid var(--color-bone-glow)`,
          transform: 'translate(-50%, -50%)',
          animation: 'arfheRingFall 0.6s cubic-bezier(0.55,0,1,0.45) 0.6s forwards',
          '@keyframes arfheRingFall': {
            '0%': { transform: 'translate(-50%, -50%) translateY(0) rotate(0deg)', opacity: 1 },
            '100%': { transform: 'translate(-50%, -50%) translateY(160px) rotate(60deg)', opacity: 0 },
          },
        }} />

        {/* BTC coin drops in, holds, then fades */}
        <Box sx={{
          position: 'absolute',
          left: `${RING_LEFT_PCT}%`,
          top: `${RING_TOP_PCT}%`,
          width: RING_DIAMETER,
          height: RING_DIAMETER,
          borderRadius: '50%',
          bgcolor: '#F7931A',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: RING_DIAMETER * 0.55,
          opacity: 0,
          animation: 'arfheCoinDrop 0.5s cubic-bezier(0.34,1.56,0.64,1) 1.3s both, arfheCoinFadeOut 0.25s ease-in 2.05s forwards',
          '@keyframes arfheCoinDrop': {
            '0%': { transform: 'translate(-50%, -50%) translateY(-140px) scale(0.6)', opacity: 0 },
            '60%': { transform: 'translate(-50%, -50%) translateY(6px) scale(1.05)', opacity: 1 },
            '80%': { transform: 'translate(-50%, -50%) translateY(-3px) scale(0.98)' },
            '100%': { transform: 'translate(-50%, -50%) translateY(0) scale(1)', opacity: 1 },
          },
          '@keyframes arfheCoinFadeOut': {
            from: { opacity: 1 },
            to: { opacity: 0 },
          },
        }}>
          ₿
        </Box>

        {/* ETH coin drops in and settles */}
        <Box sx={{
          position: 'absolute',
          left: `${RING_LEFT_PCT}%`,
          top: `${RING_TOP_PCT}%`,
          width: RING_DIAMETER,
          height: RING_DIAMETER,
          borderRadius: '50%',
          bgcolor: '#627EEA',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: RING_DIAMETER * 0.55,
          opacity: 0,
          animation: 'arfheCoinDrop2 0.5s cubic-bezier(0.34,1.56,0.64,1) 2.15s both',
          '@keyframes arfheCoinDrop2': {
            '0%': { transform: 'translate(-50%, -50%) translateY(-140px) scale(0.6)', opacity: 0 },
            '60%': { transform: 'translate(-50%, -50%) translateY(6px) scale(1.05)', opacity: 1 },
            '80%': { transform: 'translate(-50%, -50%) translateY(-3px) scale(0.98)' },
            '100%': { transform: 'translate(-50%, -50%) translateY(0) scale(1)', opacity: 1 },
          },
        }}>
          Ξ
        </Box>
      </Box>

      <Typography variant="h1" sx={{
        color: 'var(--color-bone-glow)',
        letterSpacing: 2,
        mb: 2
      }}>
        ARFHE
      </Typography>

      <Typography variant="caption" sx={{ color: 'var(--color-charcoal-vein)' }}>
        INITIALIZING SYSTEM...
      </Typography>

    </Box>
  );
}

export default Splash;
