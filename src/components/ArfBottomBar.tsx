import React, { useState, useEffect } from "react";
import {
  BottomNavigation,
  BottomNavigationAction,
  Fab,
  Drawer,
  Box,
  Paper,
} from "@mui/material";
import type { BoxProps } from "@mui/material";
import { History, Home, Send, Hub, Explore } from "@mui/icons-material";
import ArfBottomMenu from "./ArfBottomMenu";
import { useNavigate, useLocation } from "react-router";
import { useTheme } from "@mui/material";

/** Fix for MUI passing invalid props to non-Action children */
interface SafeBoxProps extends Omit<BoxProps, 'onChange'> {
  showLabel?: boolean;
  onChange?: (() => void) | null;
  value?: unknown;
}
const SafeBox = ({ showLabel: _sl, onChange: _oc, value: _v, ...props }: SafeBoxProps) => <Box {...props} />;

function ArfBottomBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      setDrawerOpen(true);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('arf-menu-set-tab', { detail: (e as CustomEvent).detail }));
      }, 100);
    };
    // Shielding lives on /privacy now. The drawer has to shut before the route changes,
    // or the send menu stays mounted over the page the user just navigated to.
    const handleClose = () => setDrawerOpen(false);

    window.addEventListener('open-arf-menu', handleOpen);
    window.addEventListener('close-arf-menu', handleClose);
    return () => {
      window.removeEventListener('open-arf-menu', handleOpen);
      window.removeEventListener('close-arf-menu', handleClose);
    };
  }, []);

  // Map path to index for highlighting
  const getSubPath = (path: string): number => {
    switch (path) {
      case '/home': return 0;
      case '/explore': return 1;
      case '/history': return 3;
      case '/agent': return 4;
      default: return 0;
    }
  };

  return (
    <Box sx={{
      width: '100%',
      maxWidth: '400px',
      position: 'fixed',
      bottom: 12,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <Paper
        elevation={4}
        sx={{
          borderRadius: '0px',
          overflow: 'hidden',
          pointerEvents: 'auto', // Re-enable clicks
          backgroundColor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px'
        }}
      >
        <BottomNavigation
          value={getSubPath(location.pathname)}
          onChange={() => {
            // value is strictly controlled by path, so onChange might not be primary driver if using navigate
          }}
          showLabels
          sx={{
            backgroundColor: 'transparent',
            height: 52,
            minWidth: 300,
            '& .MuiBottomNavigationAction-root': { 
              minWidth: 'auto', 
              padding: '4px 0',
              color: 'text.primary',
              opacity: 0.5,
            },
            '& .Mui-selected': {
              color: 'text.primary !important',
              opacity: 1,
            },
            '& .MuiBottomNavigationAction-label': { fontSize: '0.65rem' },
          }}
        >
          <BottomNavigationAction
            label="Home"
            icon={<Home sx={{ fontSize: 22 }} />}
            onClick={() => navigate('home')}
          />
          <BottomNavigationAction
            label="Explore"
            icon={<Explore sx={{ fontSize: 22 }} />}
            onClick={() => navigate('explore')}
          />

          <SafeBox sx={{ width: 56, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <Fab
              color="primary"
              aria-label="Send transaction"
              onClick={() => setDrawerOpen(true)}
              sx={{
                width: 44,
                height: 44,
                boxShadow: 'none',
                // Removed transparent background to let the vibrant primary color shine through
                color: 'primary.contrastText',
                '&:hover': {
                  transform: 'scale(1.05)',
                  boxShadow: 'none',
                },
              }}>
              <Send sx={{ fontSize: 22 }} />
            </Fab>
          </SafeBox>

          <BottomNavigationAction
            label="History"
            icon={<History sx={{ fontSize: 22 }} />}
            onClick={() => navigate('history')}
          />
          <BottomNavigationAction
            label="Agent"
            icon={<Hub sx={{ fontSize: 22 }} />}
            onClick={() => navigate('agent')}
          />
        </BottomNavigation>
      </Paper>

      <Drawer
        anchor="bottom"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        aria-label="Send transaction menu"
        PaperProps={{
          sx: {
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            maxWidth: '600px',
            mx: 'auto'
          }
        }}
      >
        <ArfBottomMenu />
      </Drawer>

    </Box>
  );
}

export default React.memo(ArfBottomBar);
