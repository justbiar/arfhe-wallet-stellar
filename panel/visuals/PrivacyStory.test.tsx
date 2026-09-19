import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivacyStory from "./PrivacyStory";
import { setPanelLanguage } from "../lib/language";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("@mui/material", () => ({ useMediaQuery: () => preference.reduced }));
vi.mock("./PrivacyScene", () => ({ default: () => <div data-testid="scene" /> }));
beforeEach(() => {
  vi.useFakeTimers(); preference.reduced = false; setPanelLanguage("en");
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { render(<MemoryRouter><PrivacyStory /></MemoryRouter>); }); };

describe("privacy story", () => {
  it("hides public amounts while the owner still sees the payment", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Salary", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Protect the amount/ }));
    expect(screen.getAllByText("••••••")).toHaveLength(3);
    expect(screen.getByText("3,250.00")).toBeTruthy();
    expect(screen.getByText("Employer → You")).toBeTruthy();
    expect(screen.getByText("G7XA…9K2F")).toBeTruthy();
    act(() => setPanelLanguage("tr"));
    expect(screen.getByText("Aylık maaş")).toBeTruthy();
    expect(screen.getAllByText("••••••")).toHaveLength(3);
  });
  it("finishes the story and offers replay", async () => {
    await mount();
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
    expect(screen.getAllByText("••••••")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.queryByText("••••••")).toBeNull();
  });
  it("respects reduced motion while retaining the manual comparison", async () => {
    preference.reduced = true; await mount();
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.queryByText("••••••")).toBeNull();
    expect(screen.getByText("Reduced motion enabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Protect the amount/ }));
    expect(screen.getAllByText("••••••")).toHaveLength(3);
  });
});
