/**
 * AgentMarkdown — renders the small slice of Markdown the agent actually writes.
 *
 * The agent formats its answers the way a language model does: `**bold**` for emphasis,
 * backticks around addresses and amounts, dashes for lists. None of that was being parsed,
 * so the user read the asterisks.
 *
 * Two rules shape this, and both come from where the text has been.
 *
 * **No HTML.** Not `dangerouslySetInnerHTML`, not a sanitizer, not a Markdown library that
 * produces an HTML string. The agent's replies quote things it read — a token name, a
 * contract's own description, a page the user asked about — and any of those can be written
 * by whoever deployed the contract. In a wallet, a rendering path that turns attacker-chosen
 * text into markup is not a formatting bug waiting to happen, it is a phishing surface. This
 * builds React elements from the parsed text instead, so there is no point at which a string
 * could become an element.
 *
 * **No links.** A URL is left as plain text, unclickable. The agent can be wrong, and it can
 * be steered by content it was asked to read; a clickable link in a wallet's own chat carries
 * the wallet's authority to whatever it points at. The user can still select and copy it,
 * which costs them one deliberate action and removes the accidental click entirely.
 */

import { Box, Typography } from "@mui/material";
import React from "react";

/**
 * Inline spans: `code`, **bold**, *italic*. Ordered so code wins — its content is literal.
 *
 * Underscores are deliberately not emphasis here, though Markdown allows `_italic_`. The
 * agent's replies are full of snake_case — tool names like `propose_send`, contract methods,
 * event names — and treating `_` as a delimiter turns `wrap_and_send` into "wrapandsend"
 * with the middle word in italics. Losing a character out of an identifier the user might
 * copy is worse than losing a formatting style the agent barely uses.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    const token = match[0];
    const key = `${keyPrefix}-i${n++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <Box
          key={key}
          component="code"
          sx={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.92em",
            px: 0.5,
            py: 0.1,
            border: "1px solid",
            borderColor: "divider",
            // Addresses and hashes are long and must not push the bubble sideways.
            wordBreak: "break-all",
          }}
        >
          {token.slice(1, -1)}
        </Box>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*```/;
/** "- item", "* item", "• item" */
const BULLET = /^\s*[-*•]\s+(.*)$/;
/** "1. item", "1) item" */
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
/** "# Heading" through "###### Heading" */
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export default function AgentMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");

  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code ──────────────────────────────────────────────────────────
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence, or the end of the text if it was never closed
      blocks.push(
        <Box
          key={`b${blockIndex++}`}
          component="pre"
          sx={{
            m: 0,
            my: 0.5,
            p: 1,
            border: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.8rem",
            // The panel is narrow; a long line scrolls rather than widening the bubble.
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {body.join("\n")}
        </Box>,
      );
      continue;
    }

    // ── Lists ────────────────────────────────────────────────────────────────
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const items: Array<{ marker: string; content: string }> = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const nm = NUMBERED.exec(lines[i]);
        if (b) items.push({ marker: "•", content: b[1] });
        else if (nm) items.push({ marker: `${nm[1]}.`, content: nm[2] });
        else break;
        i++;
      }
      blocks.push(
        <Box key={`b${blockIndex++}`} sx={{ my: 0.5 }}>
          {items.map((item, index) => (
            <Box key={index} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", flexShrink: 0, minWidth: item.marker.length > 1 ? 18 : 10 }}
              >
                {item.marker}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.primary", minWidth: 0 }}>
                {renderInline(item.content, `b${blockIndex}-${index}`)}
              </Typography>
            </Box>
          ))}
        </Box>,
      );
      continue;
    }

    // ── Heading ──────────────────────────────────────────────────────────────
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push(
        <Typography
          key={`b${blockIndex++}`}
          variant="body2"
          sx={{ color: "text.primary", fontWeight: 700, mt: 0.75, mb: 0.25 }}
        >
          {renderInline(heading[1], `b${blockIndex}`)}
        </Typography>,
      );
      i++;
      continue;
    }

    // ── Paragraph ────────────────────────────────────────────────────────────
    // Consecutive plain lines stay one paragraph, keeping their line breaks: the agent
    // uses a single newline to lay out short facts, and collapsing those into one run of
    // text would undo the structure it was reaching for.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !HEADING.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }

    if (paragraph.length > 0) {
      blocks.push(
        <Typography
          key={`b${blockIndex++}`}
          variant="body2"
          sx={{ color: "text.primary", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {renderInline(paragraph.join("\n"), `b${blockIndex}`)}
        </Typography>,
      );
    } else {
      i++; // blank line
    }
  }

  return <>{blocks}</>;
}
