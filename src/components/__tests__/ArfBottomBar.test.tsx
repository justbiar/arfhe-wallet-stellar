import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import ArfBottomBar from "../ArfBottomBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Exercise the real navigation and drawer without connecting a wallet or creating a transfer.
vi.mock("../panels/SendPanel.js", () => ({ default: () => <div>Send form</div> }));
vi.mock("../panels/ReceivePanel.js", () => ({ default: () => <div>Receive address</div> }));

describe("wallet action drawer", () => {
  it("opens Receive from a shortcut, closes, and reopens Send from navigation", async () => {
    render(<MemoryRouter initialEntries={["/home"]}><ArfBottomBar /></MemoryRouter>);
    act(() => window.dispatchEvent(new CustomEvent("open-arf-menu", { detail: { tab: 1 } })));
    expect(await screen.findByText("Receive address")).toBeVisible();
    expect(screen.getByRole("tab", { name: "common.receive" })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)).toHaveTextContent("common.receive");

    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    await waitFor(() => expect(screen.queryByText("Receive address")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "common.send" }));
    expect(await screen.findByText("Send form")).toBeVisible();
    expect(screen.getByRole("tab", { name: "common.send" })).toHaveAttribute("aria-selected", "true");
  });
});
