/**
 * Agent.tsx — In-wallet AI Agent page.
 *
 * Thin wrapper around AgentChatPanel: this route's only job is to give the panel a
 * full-height slot inside AppLayout. All actual chat/tool-calling logic lives in
 * AgentChatPanel.tsx / AgentOrchestrator.ts.
 */

import { Box } from "@mui/material";
import AgentChatPanel from "../components/AgentChatPanel.js";

function Agent() {
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <AgentChatPanel />
    </Box>
  );
}

export default Agent;
