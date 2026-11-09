/**
 * DuoAudio - Electron Main Process IPC Handlers
 *
 * Implements allowlisted IPC communication with the renderer process.
 * Validates all requests, enforces sender frame security, and routes
 * device enumeration queries to the device service.
 */

const { ipcMain } = require('electron');
const { IPC_CHANNELS } = require('../../shared/ipc-contracts');
const { enumeratePlaybackDevices } = require('../device-service');

/**
 * Registers all allowlisted IPC handlers for the main window.
 * @param {BrowserWindow} mainWindow
 */
function registerIpcHandlers(mainWindow) {
  // Security guard helper
  const isSenderValid = (event) => {
    return event.senderFrame === mainWindow.webContents.mainFrame;
  };

  // Window Minimize: Hides window to tray
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    if (!isSenderValid(event)) {
      console.warn('[SECURITY] Rejected WINDOW_MINIMIZE from non-main frame');
      return;
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.hide();
      console.log('[IPC] Window minimized to tray.');
    }
  });

  // Audio Devices Query (Phase 5B)
  ipcMain.handle(IPC_CHANNELS.DEVICES_GET, async (event) => {
    if (!isSenderValid(event)) {
      console.warn('[SECURITY] Rejected DEVICES_GET from non-main frame');
      return { success: false, devices: [], error: 'Unauthorized IPC origin' };
    }
    return enumeratePlaybackDevices();
  });

  // Audio Devices Refresh (Phase 5B)
  ipcMain.handle(IPC_CHANNELS.DEVICES_REFRESH, async (event) => {
    if (!isSenderValid(event)) {
      console.warn('[SECURITY] Rejected DEVICES_REFRESH from non-main frame');
      return { success: false, devices: [], error: 'Unauthorized IPC origin' };
    }
    console.log('[IPC] Re-enumerating active Windows playback endpoints...');
    return enumeratePlaybackDevices();
  });

  // App Initial State
  ipcMain.handle(IPC_CHANNELS.APP_GET_INITIAL_STATE, (event) => {
    if (!isSenderValid(event)) {
      return { appVersion: '0.1.0' };
    }
    return {
      appVersion: '0.1.0 (Phase 5B Real Device Integration)',
      routingStatus: 'READY'
    };
  });

  // Routing Status Query (Start Sharing remains disabled in Phase 5B)
  ipcMain.handle(IPC_CHANNELS.ROUTING_GET_STATUS, (event) => {
    return {
      status: 'READY',
      isRouting: false
    };
  });
}

module.exports = {
  registerIpcHandlers
};
