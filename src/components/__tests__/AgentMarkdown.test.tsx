/**
 * What the agent's formatting turns into on screen.
 *
 * The security assertions matter more than the formatting ones. The agent quotes text it
 * read — token names, contract metadata, page content — and any of that can be written by
 * whoever deployed the contract. So the tests check not just that `**bold**` becomes bold,
 * but that markup in the input stays inert and that a URL never becomes something the user
 * can click by accident.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AgentMarkdown from "../AgentMarkdown";

describe("AgentMarkdown", () => {
  it("renders **bold** as bold, not as asterisks", () => {
    const { container } = render(<AgentMarkdown text="Your balance is **7.80 USD** today." />);
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("7.80 USD");
    expect(container.textContent).not.toContain("**");
  });

  it("renders *italic*", () => {
    const { container } = render(<AgentMarkdown text="*one* and two" />);
    expect(container.querySelectorAll("em")).toHaveLength(1);
    expect(container.textContent).toBe("one and two");
  });

  it("leaves snake_case identifiers whole", () => {
    // Underscores are not emphasis here. The agent names tools and contract methods in
    // snake_case constantly, and an identifier the user might copy must survive intact —
    // "wrap_and_send" becoming "wrapandsend" is a broken value, not a styling quirk.
    const { container } = render(
      <AgentMarkdown text="Calling wrap_and_send with max_fee_per_gas set." />,
    );
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toContain("wrap_and_send");
    expect(container.textContent).toContain("max_fee_per_gas");
  });

  it("renders `code`, and keeps a long address unbroken as text", () => {
    const address = "0x93789f7FD273301129c8F4E023aBfDFBDd62f2A3";
    const { container } = render(<AgentMarkdown text={`Send to \`${address}\` now`} />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe(address);
    expect(container.textContent).not.toContain("`");
  });

  it("does not treat asterisks inside code as emphasis", () => {
    const { container } = render(<AgentMarkdown text="`a ** b`" />);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("a ** b");
  });

  it("renders bullet lists", () => {
    const { container } = render(<AgentMarkdown text={"- first\n- second"} />);
    expect(container.textContent).toContain("first");
    expect(container.textContent).toContain("second");
    expect(container.textContent).not.toContain("- first");
  });

  it("renders numbered lists keeping their numbers", () => {
    const { container } = render(<AgentMarkdown text={"1. alpha\n2. beta"} />);
    expect(container.textContent).toContain("1.");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("2.");
  });

  it("renders a fenced code block verbatim", () => {
    const { container } = render(<AgentMarkdown text={"```\nline one\nline two\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("line one\nline two");
  });

  it("renders a heading as emphasis rather than dropping the hashes into the text", () => {
    const { container } = render(<AgentMarkdown text="## Summary" />);
    expect(container.textContent).toBe("Summary");
  });

  it("keeps single newlines, which the agent uses to lay out short facts", () => {
    render(<AgentMarkdown text={"Balance: 1 ETH\nNetwork: Sepolia"} />);
    expect(screen.getByText(/Balance: 1 ETH/)).toBeInTheDocument();
  });

  // ── The reason this component exists rather than a Markdown library ──

  it("never turns input into HTML elements", () => {
    const hostile = '<img src=x onerror="alert(1)"> <b>not bold</b>';
    const { container } = render(<AgentMarkdown text={hostile} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // The markup survives as literal text the user can see for what it is.
    expect(container.textContent).toContain("<img");
    expect(container.textContent).toContain("<b>not bold</b>");
  });

  it("never renders a clickable link", () => {
    const { container } = render(
      <AgentMarkdown text="Visit https://arfhe.example and [click](https://evil.example)" />,
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
    // Still readable and copyable — the user loses the click, not the information.
    expect(container.textContent).toContain("https://arfhe.example");
  });

  it("does not execute or strip a script tag, it shows it", () => {
    const { container } = render(<AgentMarkdown text="<script>steal()</script>" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>steal()</script>");
  });
});
