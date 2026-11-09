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
    const isRouting = lifecycle.isRoutingActive;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open DuoAudio',
        click: () => {
          restoreAndFocusWindow();
        }
      },
      {
        label: isRouting ? 'Stop Routing' : 'Start Routing',
        enabled: false, // Explicitly disabled for Phase 5A foundation
        sublabel: 'Audio engine integration in Phase 5B',
        click: () => {
          // Deferred to Phase 5B
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

  updateContextMenu();

  return tray;
}

module.exports = {
  createSystemTray
};
