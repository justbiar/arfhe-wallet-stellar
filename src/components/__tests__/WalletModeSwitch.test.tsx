import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import WalletModeSwitch from "../WalletModeSwitch";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** Renders the switch and a stand-in for each destination, so navigation is observable. */
function mount(mode: "web3" | "bank", at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <WalletModeSwitch mode={mode} />
      <Routes>
        <Route path="/home" element={<div>web3 view</div>} />
        <Route path="/bank" element={<div>bank view</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("wallet mode switch", () => {
  it("marks the current mode and moves to the other one", () => {
    mount("web3", "/home");
    const web3 = screen.getByRole("button", { name: "bank.modeWeb3" });
    const bank = screen.getByRole("button", { name: "bank.modeBank" });
    expect(web3).toHaveAttribute("aria-pressed", "true");
    expect(bank).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("web3 view")).toBeVisible();

    fireEvent.click(bank);
    expect(screen.getByText("bank view")).toBeVisible();
  });

  it("does not navigate when the active mode is pressed again", () => {
    mount("bank", "/bank");
    expect(screen.getByText("bank view")).toBeVisible();

    // A segment that re-navigates to where it already is pushes a duplicate history entry,
    // which turns the wallet's back button into something that appears not to work.
    fireEvent.click(screen.getByRole("button", { name: "bank.modeBank" }));
    expect(screen.getByText("bank view")).toBeVisible();
    expect(screen.queryByText("web3 view")).not.toBeInTheDocument();
  });
});
