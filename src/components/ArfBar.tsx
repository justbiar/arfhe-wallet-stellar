import * as React from "react";
import {
  AppBar,
  Box,
  Toolbar,
  Alert,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  CameraAlt,
  QrCode,
} from "@mui/icons-material";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import NotificationPanel from "./NotificationPanel.js";
import NetworkHealthIndicator from "./NetworkHealthIndicator.js";
import AccountSwitcher from "./AccountSwitcher.js";
import ScanDialog from "./panels/ScanDialog.js";

function ArfBar({ network, setNetwork }: { network: number; setNetwork: React.Dispatch<React.SetStateAction<number>> }) {
  const wallet = React.useContext(WalletContext);
  const { activeIndex, activeAccount } = useActiveAccount();
  const [scanOpen, setScanOpen] = React.useState(false);

  if (!wallet) return <Alert severity="error">AppContext is lost</Alert>;

  return (
    <Box sx={{ 
      width: '100%', 
      maxWidth: '400px',
      position: 'fixed',
      top: 0,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 1100,
      bgcolor: 'background.default',
      borderLeft: '1px solid',
      borderRight: '1px solid',
      borderColor: 'divider',
    }}>
      {/* AppBar */}
      <Box sx={{ flexGrow: 1 }}>
        <AppBar color="transparent" elevation={0} position="static">
          <Toolbar sx={{ justifyContent: "space-between", px: 1, minHeight: '56px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box
                component="img"
                src="/Arfhe-logo.png"
                alt="Arfhe"
                sx={{
                  width: 22,
                  height: 22,
                  flexShrink: 0,
                  filter: (theme) => theme.palette.mode === 'dark' ? 'invert(1) brightness(1.05)' : 'none',
                }}
              />
              {/* Account Switcher — MetaMask-style dropdown */}
              <AccountSwitcher />
            </Box>

            {/* Scan, WC, Network Health & Notifications */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
              <Tooltip title="WalletConnect" arrow>
                <IconButton
                  size="small"
                  onClick={() => setScanOpen(true)}
                  aria-label="WalletConnect"
                  sx={{ color: 'text.secondary', p: 0.5 }}
                >
                  <QrCode sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              <NetworkHealthIndicator />
              <NotificationPanel />
            </Box>
          </Toolbar>
        </AppBar>
      </Box>



      {/* WalletConnect Scan Dialog */}
      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} />
    </Box>
  );
}

export default React.memo(ArfBar);
