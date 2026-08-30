import { useNavigate } from "react-router";
import { Box } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Splash — the brand animation the wallet opens on.
 *
 * A video rather than the hand-built mark it replaced. The one rule that matters here is
 * that this screen must never be able to hold the wallet shut: it sits in front of the
 * user's funds, and a codec that will not decode, an autoplay policy that refuses, or a
 * file that failed to load are all reasons to move on rather than reasons to stop.
 *
 * So every path out is covered — the video ending, the video erroring, the user tapping,
 * and a deadline that fires whether or not anything else did. Whichever happens first
 * wins, and the rest are ignored.
 */

/**
 * How long the splash may hold the screen.
 *
 * The clip runs a little over five seconds. This is the backstop for the case where it
 * never reports finishing at all — muted autoplay is normally permitted, but a policy that
 * blocks it produces a video element that simply sits there, and without a deadline that
 * is a wallet that never opens.
 */
const MAX_SPLASH_MS = 5600;

function Splash() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Guards against two exits racing — the deadline and the `ended` event, typically. */
  const doneRef = useRef(false);
  const [videoFailed, setVideoFailed] = useState(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    navigate("auth", { replace: true });
  }, [navigate]);

  useEffect(() => {
    const deadline = setTimeout(finish, MAX_SPLASH_MS);

    // Autoplay is requested through the attribute *and* here: the attribute covers the
    // normal case, and this covers a element that mounted before the source was ready.
    // A rejected play is not an error worth showing — it just means we leave sooner.
    videoRef.current?.play().catch(() => setVideoFailed(true));

    return () => clearTimeout(deadline);
  }, [finish]);

  return (
    <Box
      onClick={finish}
      sx={{
        height: "100%",
        width: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        // Matches the clip's own background, so the letterboxing on a viewport that is not
        // exactly 9:16 reads as part of the animation rather than as a gap around it.
        background: "#0d0d0d",
        position: "relative",
        overflow: "hidden",
        cursor: "pointer",
      }}
      // Tapping skips. Nobody wants to sit through a five-second logo every time they
      // check a balance, and the second viewing is already the second too many.
      role="button"
      aria-label="Skip"
    >
      {!videoFailed && (
        <Box
          component="video"
          ref={videoRef}
          src="/splash.mp4"
          autoPlay
          muted
          playsInline
          preload="auto"
          onEnded={finish}
          onError={() => setVideoFailed(true)}
          sx={{
            width: "100%",
            height: "100%",
            // `cover` rather than `contain`: the clip is 9:16 and the popup is 2:3, so
            // something has to give. Cropping a little off the top and bottom of a centred
            // mark is less noticeable than bars down both sides.
            objectFit: "cover",
            display: "block",
          }}
        />
      )}

      {/* Shown only if the video cannot play at all, so the wallet still opens on its own
          mark instead of on an empty black rectangle. */}
      {videoFailed && (
        <Box
          component="img"
          src="/Arfhe-logo.png"
          alt="Arfhe"
          sx={{ width: 140, filter: "invert(1) brightness(1.05)" }}
        />
      )}
    </Box>
  );
}

export default Splash;
