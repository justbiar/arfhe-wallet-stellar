/// <reference types="vitest/globals" />

/**
 * The loop that froze the wallet.
 *
 * Four screens declare a hunt state from an effect and list the hook's return value as a
 * dependency, which is the ordinary thing to do. The hook used to build `{ setState, pulse }`
 * fresh on every render, so that dependency changed on every render, so the effect re-ran on
 * every render — and these effects set state. Cleanup wrote false, the effect wrote true, the
 * provider re-rendered, the object was new again, forever.
 *
 * Nothing threw, so the console stayed clean and the wallet simply stopped answering clicks.
 * These tests hold the two properties that make that impossible.
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { HuntStateProvider, useHuntState, useHuntStates } from "../HuntStateProvider";

/**
 * Reproduces exactly what Agent, Privacy and TokenDetail do.
 *
 * It reads the states as well as the actions. That is not decoration: a screen that never
 * re-renders when the states change can never observe an unstable actions object, so a test
 * without this subscription passes whether the bug is present or not. It has to be here for
 * these tests to mean anything.
 */
function DeclaringScreen({ active, onRender }: { active: boolean; onRender: () => void }) {
    const hunt = useHuntState();
    useHuntStates();
    onRender();

    React.useEffect(() => {
        hunt.setState("agent-10-messages", active);
        return () => hunt.setState("agent-10-messages", false);
    }, [active, hunt]);

    return null;
}

function StatesReadout() {
    return <div data-testid="states">{useHuntStates().join(",")}</div>;
}

describe("HuntStateProvider", () => {
    it("bir durum bildiren ekran sonsuz döngüye girmez", () => {
        let renders = 0;

        render(
            <HuntStateProvider>
                <DeclaringScreen active onRender={() => { renders += 1; }} />
                <StatesReadout />
            </HuntStateProvider>,
        );

        expect(screen.getByTestId("states").textContent).toBe("agent-10-messages");

        // The loop showed up as an unbounded render count. A handful is normal for React's
        // effect-then-commit cycle; anything near a hundred is the bug back.
        expect(renders).toBeLessThan(10);
    });

    it("eylem nesnesi render'lar arasında kimliğini korur", () => {
        const seen = new Set<unknown>();

        function Probe() {
            const hunt = useHuntState();
            // Subscribed to the states, so this really does re-render between the clicks
            // below — which is the only condition under which an unstable object shows up.
            const states = useHuntStates();
            seen.add(hunt);
            return (
                <button onClick={() => hunt.setState(`s${states.length}`, true)}>go</button>
            );
        }

        render(<HuntStateProvider><Probe /><StatesReadout /></HuntStateProvider>);

        act(() => { screen.getByText("go").click(); });
        act(() => { screen.getByText("go").click(); });

        // Several renders happened and the states really did change; the actions object must
        // still be the one object, or every dependency array holding it is a loop.
        expect(screen.getByTestId("states").textContent).not.toBe("");
        expect(seen.size).toBe(1);
    });

    it("aynı değeri iki kez yazmak yeni bir dizi üretmez", () => {
        const arrays: string[][] = [];

        function Probe() {
            const { setState } = useHuntState();
            arrays.push(useHuntStates());
            return <button onClick={() => setState("x", true)}>go</button>;
        }

        render(<HuntStateProvider><Probe /></HuntStateProvider>);
        act(() => { screen.getByText("go").click(); });
        const afterFirst = arrays.length;
        act(() => { screen.getByText("go").click(); });

        // The second click is a no-op, so it must not re-render anything.
        expect(arrays.length).toBe(afterFirst);
    });
});
