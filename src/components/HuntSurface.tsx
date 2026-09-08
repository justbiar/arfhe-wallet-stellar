/**
 * HuntSurface — the one place in the wallet that can show a hunt mark.
 *
 * Mounted once, above the router. On every screen change it asks the server whether this
 * screen carries a mark, and draws one if the answer is yes.
 *
 * This exists because the previous design wrote the map into the source: each screen named
 * its own fragment, so anyone who read the built folder learned the entire layout of the
 * hunt in one pass. Encrypting that list would not have helped — a bundle that can decrypt
 * something ships the key to decrypt it, which is a lock with its key taped to the front.
 * The only way a bundle keeps a secret is by not containing it.
 *
 * So the bundle contains a question and no answers. What it can still reveal is the wallet's
 * own list of screens, which means someone can sign once and ask about each in turn until
 * the map falls out. That is a real limit and worth being plain about: it is not what
 * protects the prize. The gates do, and no amount of reading produces the on-chain work a
 * gate asks for.
 */

import { useContext, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Box, useTheme } from "@mui/material";

import { WalletContext } from "../AppContext";
import { toChainId } from "../backend/NetworkTypes";
import { marksForRoute, type HuntMarkSpec } from "../backend/HuntService";
import { useHuntStates } from "./HuntStateProvider";
import HuntMark from "./HuntMark";

interface HuntSurfaceProps {
  /**
   * Name the moment instead of taking it from the URL.
   *
   * Some places worth hiding something are not routes: the screen shown after a transfer
   * is a panel inside a drawer, and the URL underneath it still says whatever page the
   * drawer was opened from. Naming it lets the server treat it as its own place.
   */
  route?: string;
  /**
   * Sit in the corner of the surrounding panel rather than floating above the window.
   *
   * The floating position is right for a screen and wrong inside a drawer twice over: a
   * drawer is painted over everything, so a mark fixed to the window is behind it, and a
   * mark added to the end of the panel's own flow lands under the buttons where a short
   * drawer simply cuts it off.
   *
   * The container needs `position: relative` for this to land anywhere useful.
   */
  inline?: boolean;
}

export default function HuntSurface({ route: routeOverride, inline = false }: HuntSurfaceProps = {}) {
  const location = useLocation();
  const theme = useTheme();
  const context = useContext(WalletContext);
  const [marks, setMarks] = useState<HuntMarkSpec[]>([]);

  const account = context?.accountManager?.GetActive();
  const address = account?.GetAddress();
  /**
   * The screen, not the thing it is showing.
   *
   * `/token/:address` arrives here as `/token/0x6bA0…`, which matches nothing a server
   * config can name without listing every token address — so the mark that hides on a
   * token page could never appear. Which token it is travels as a state instead, where it
   * belongs: the screen is the place, the token is the condition.
   */
  const pathname = location.pathname.replace(/^\/token\/.+$/, "/token");
  const route = routeOverride ?? pathname;
  const mode = theme.palette.mode;
  // Through `toChainId`, not the raw network id. `NetworkId` is the wallet's own
  // numbering and is not the chain id — Sepolia is 4 internally and 11155111 on chain —
  // so reporting it raw named a chain that does not exist. The three marks that hide
  // behind a particular network could never appear.
  const rawNetworkId = context?.networkProvider?.getActiveNetworkId();
  const chain = rawNetworkId === undefined ? "" : String(toChainId(rawNetworkId));

  /**
   * Facts about this moment that a screen can hand up.
   *
   * Screens push into this rather than the surface reaching into each of them: a screen
   * knows whether its own dialog is open or its own list is empty, and having the hunt
   * inspect thirteen screens' internals would put a piece of the hunt back into every one
   * of them — which is the arrangement this design exists to undo.
   */
  const states = useHuntStates();

  useEffect(() => {
    let cancelled = false;
    setMarks([]);

    // Re-asked whenever any of these change, because each is part of the hiding place: the
    // same screen on a different network, or in the other theme, is a different question.
    // Keyed on the address too — the arrangement is per-account, so switching accounts is a
    // new question rather than a cached answer.
    void marksForRoute({ route, theme: mode, chain, states }, account).then((found) => {
      if (!cancelled) setMarks(found);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, address, mode, chain, states.join(",")]);

  const visible = marks;

  if (visible.length === 0) return null;

  return (
    <Box
      sx={{
        // Bottom-left, above the page and clear of the bottom navigation. Fixed so it does
        // not move a screen's own layout by one pixel — a hunt must not be the reason a
        // balance sits somewhere unexpected. Inline where a drawer would paint over it.
        ...(inline
          ? { position: "absolute", top: 0, right: 0 }
          : { position: "fixed", left: 12, bottom: 96 }),
        zIndex: 3,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        // The container itself must never take a click. Once a word is revealed this box
        // grows to the width of the panel, and with `auto` that whole rectangle sat over
        // the page swallowing taps meant for whatever was underneath it.
        //
        // Deliberately no `& > *` rule turning it back on for the children: that selector
        // and the child's own class have equal specificity, so which one wins comes down to
        // stylesheet order — which emotion does not promise. HuntMark switches its own
        // interactive parts back on instead, where nothing can outrank it.
        pointerEvents: "none",
      }}
    >
      {visible.map((m) => (
        <HuntMark key={m.id} fragmentId={m.id} hint="Arfhe" size={m.size ?? 30} />
      ))}
    </Box>
  );
}
