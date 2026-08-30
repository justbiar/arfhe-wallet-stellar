import React from 'react';
import { Outlet } from 'react-router';
import ArfBottomBar from './components/ArfBottomBar';
import ArfBar from './components/ArfBar';
import { Box } from '@mui/material';
import { ActiveAccountProvider } from './ActiveAccountProvider';
import { AgentSessionProvider } from './AgentSessionProvider';

const AppLayout: React.FC = () => {
  const [network, setNetwork] = React.useState(1);

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: 'background.default', position: 'relative' }}>
      <ActiveAccountProvider>
        {/* Mounted here rather than inside the Agent page itself so an in-flight agent turn
            survives switching to another tab (Home, History, ...) — AppLayout, and everything
            inside it, stays mounted across nested route changes; only <Outlet/>'s content
            swaps. See AgentSessionProvider's own docs for the bug this closes. */}
        <AgentSessionProvider>
          {/* Accessibility: skip link for keyboard users */}
          <a href="#main-content" className="skip-to-content">Skip to content</a>

          <Box component="header" sx={{ flexShrink: 0 }}>
            <ArfBar network={network} setNetwork={setNetwork} />
          </Box>

          {/* Padding, not margin.
              The header and nav are fixed, so they take no flex space and `flex: 1` hands
              this box the full height — and then 56px + 80px of margin were added on top
              of that, making the content area 136px taller than the window it sits in.
              Pages that pad their own bottom and scroll never showed it; the agent chat,
              which sizes itself with `height: 100%` so its message list can scroll
              independently, inherited the overflow and ran off the bottom of the
              extension. Padding offsets the content under the fixed bars without growing
              the box. */}
          <Box component="main" id="main-content" tabIndex={-1} sx={{ flex: 1, pt: '56px', pb: '80px', overflowY: 'auto', minHeight: 0 }}>
            <Outlet />
          </Box>

          <Box component="nav" aria-label="Main navigation" sx={{ flexShrink: 0 }}>
            <ArfBottomBar />
          </Box>
        </AgentSessionProvider>
      </ActiveAccountProvider>
    </Box>
  );
}

export default AppLayout;
