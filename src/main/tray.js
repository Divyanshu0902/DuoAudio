/**
 * DuoAudio - System Tray Manager
 *
 * Implements persistent system tray presence, double-click window restore,
 * and the exact 4-item context menu required by the product specification.
 */

const { Tray, Menu, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { lifecycle } = require('./lifecycle');
const { audioService } = require('./audio-service');
const { IPC_CHANNELS } = require('../shared/ipc-contracts');

/**
 * Creates and configures the system tray instance.
 * @param {BrowserWindow} mainWindow
 * @returns {Tray}
 */
function createSystemTray(mainWindow) {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  if (!fs.existsSync(iconPath)) {
    console.warn('[TRAY WARNING] Tray icon asset not found at:', iconPath);
  }

  const tray = new Tray(iconPath);
  tray.setToolTip('DuoAudio');

  // Function to always restore and focus window (never toggles/hides)
  function restoreAndFocusWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.show();
    mainWindow.focus();
  }

  // Single-click always restores and focuses the window
  tray.on('click', () => {
    restoreAndFocusWindow();
  });

  // Double-click also restores and focuses (idempotent, never toggles/hides)
  tray.on('double-click', () => {
    restoreAndFocusWindow();
  });

  // Construct context menu with exact specified items
  function updateContextMenu() {
    const isRouting = audioService.isRouting;
    const state = audioService.state;
    const isTransitioning = state === 'STARTING' || state === 'STOPPING';

    if (state === 'RUNNING') {
      tray.setToolTip('DuoAudio — Streaming Active');
    } else if (state === 'PARTIALLY_DEGRADED') {
      tray.setToolTip('DuoAudio — Degraded Stream');
    } else if (state === 'STARTING') {
      tray.setToolTip('DuoAudio — Starting...');
    } else if (state === 'STOPPING') {
      tray.setToolTip('DuoAudio — Stopping...');
    } else {
      tray.setToolTip('DuoAudio');
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open DuoAudio',
        click: () => {
          restoreAndFocusWindow();
        }
      },
      {
        label: isRouting ? 'Stop Routing' : 'Start Routing',
        enabled: !isTransitioning,
        click: async () => {
          if (audioService.isRouting) {
            console.log('[TRAY] Stop Routing triggered from system tray.');
            await audioService.stopRouting();
          } else {
            console.log('[TRAY] Start Routing triggered from system tray.');
            restoreAndFocusWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_CHANNELS.TRAY_TRIGGER_START);
            }
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit DuoAudio',
        click: () => {
          lifecycle.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  }

  // Dynamically update tray menu on routing status transitions
  const unsubscribeStatus = audioService.onStatusChanged(() => {
    updateContextMenu();
  });

  mainWindow.on('closed', () => {
    unsubscribeStatus();
  });

  updateContextMenu();

  return tray;
}

module.exports = {
  createSystemTray
};
