/**
 * The connection has to outlive the route.
 *
 * Both panes are rendered by the bridge route, so navigating to another page unmounts them.
 * When the ramp's state lived in the hook, that unmount took the connected account and any
 * open order with it and the site looked like the wallet had disconnected — while the wallet
 * itself had done nothing. These tests hold that boundary: what a remount sees, and what a
 * second, simultaneous reader sees.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRamp, type Ramp } from "./useRamp";

function Probe({ id }: { id: string }) {
  const ramp = useRamp();
  handle = ramp;
  return <span data-testid={id}>{ramp.phase}</span>;
}

let handle: Ramp;

afterEach(cleanup);

describe("useRamp", () => {
  it("keeps the connection when the route unmounts the panes", async () => {
    const first = render(<Probe id="a" />);
    expect(screen.getByTestId("a").textContent).toBe("disconnected");

    // `reset` is the one state change that needs no anchor and no signature, which makes it
    // the honest way to move the store without standing up the network.
    await act(async () => { handle.reset(); });
    expect(screen.getByTestId("a").textContent).toBe("ready");

    // Navigating away, and back.
    first.unmount();
    render(<Probe id="b" />);
    expect(screen.getByTestId("b").textContent).toBe("ready");
  });

  it("shows one connection to every reader at once", async () => {
    render(
      <>
        <Probe id="left" />
        <Probe id="right" />
      </>,
    );

    await act(async () => { handle.reset(); });

    expect(screen.getByTestId("left").textContent).toBe("ready");
    expect(screen.getByTestId("right").textContent).toBe("ready");
  });
});
