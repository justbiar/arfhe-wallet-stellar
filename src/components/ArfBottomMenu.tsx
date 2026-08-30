import React from "react";
import {
  Box,
  Tabs,
  Tab,
  Stack,
} from "@mui/material";
import {
  Send as SendIcon,
  CallReceived,
} from "@mui/icons-material";
import { CustomTabPanel } from "./panels/shared.js";
import SendPanel from "./panels/SendPanel.js";
import ReceivePanel from "./panels/ReceivePanel.js";

/** Tabs this drawer has. Anything asking for a higher index is asking for a tab that
 *  no longer exists — swap was removed rather than hidden, so it must not be reachable. */
const TAB_COUNT = 2;

export default function ArfBottomMenu() {
  const [value, setValue] = React.useState(0);

  React.useEffect(() => {
    const handleSetTab = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab !== undefined) {
        // Callers still pass the old indices (0=Send, 1=Receive, 2=Swap). Clamping rather
        // than ignoring keeps an old "open swap" request landing on a real tab instead of
        // leaving the drawer blank.
        const tab = Number(detail.tab);
        if (Number.isFinite(tab) && tab >= 0) setValue(Math.min(tab, TAB_COUNT - 1));
      }
      // Prefill send token if provided, along with whether it is a confidential one.
      if (detail?.token) {
        window.dispatchEvent(new CustomEvent('arf-send-prefill', {
          detail: { token: detail.token, confidential: !!detail.confidential },
        }));
      }
    };
    window.addEventListener('arf-menu-set-tab', handleSetTab);
    return () => window.removeEventListener('arf-menu-set-tab', handleSetTab);
  }, []);

  const handleChange = (_event: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
  };

  return (
    <Box sx={{ px: 1.5, pt: 0.5, pb: 1, height: '75vh', maxHeight: 470, overflowY: 'auto' }}>
      {/* Drawer Handle */}
      <Stack direction="row" justifyContent="center" sx={{ mb: 0.5 }}>
        <Box sx={{
          width: 36, height: 4, borderRadius: 2,
          bgcolor: 'divider',
        }} />
      </Stack>

      {/* Tabs — Send and Receive */}
      <Tabs
        value={value}
        onChange={handleChange}
        centered
        sx={{
          minHeight: 28,
          mb: 0.25,
          '& .MuiTabs-indicator': {
            height: 2,
            borderRadius: '2px 2px 0 0',
            bgcolor: 'primary.main',
          },
          '& .MuiTab-root': {
            fontWeight: 700,
            fontSize: '0.72rem',
            minHeight: 28,
            py: 0.25,
            px: 1.5,
            textTransform: 'none',
            color: 'text.secondary',
            '&.Mui-selected': { color: 'text.primary' },
          },
        }}
      >
        <Tab icon={<SendIcon sx={{ fontSize: 14 }} />} iconPosition="start" label="Send" />
        <Tab icon={<CallReceived sx={{ fontSize: 14 }} />} iconPosition="start" label="Receive" />
      </Tabs>

      <CustomTabPanel value={value} index={0}>
        <SendPanel />
      </CustomTabPanel>
      <CustomTabPanel value={value} index={1}>
        <ReceivePanel />
      </CustomTabPanel>
    </Box>
  );
}
