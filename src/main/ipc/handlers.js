/**
 * DuoAudio - Electron Main Process IPC Handlers
 *
 * Implements allowlisted IPC communication with the renderer process.
 * Validates all requests, enforces sender frame security, and routes
 * device enumeration queries to the device service.
 */

const { ipcMain } = require('electron');
const { IPC_CHANNELS, isValidRoutingStartPayload } = require('../../shared/ipc-contracts');
const { enumeratePlaybackDevices } = require('../device-service');
const { audioService } = require('../audio-service');

/**
 * Registers all allowlisted IPC handlers for the main window.
 * @param {BrowserWindow} mainWindow
 */
function registerIpcHandlers(mainWindow) {
  // Security guard helper
  const isSenderValid = (event) => {
    return event.senderFrame === mainWindow.webContents.mainFrame;
  };

  // Forward audioService status updates to renderer
  const unsubscribeStatus = audioService.onStatusChanged((status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.ROUTING_STATUS_CHANGED, status);
    }
  });

  mainWindow.on('closed', () => {
    unsubscribeStatus();
  });

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

  // Routing Status Query (Phase 5C.2)
  ipcMain.handle(IPC_CHANNELS.ROUTING_GET_STATUS, (event) => {
    if (!isSenderValid(event)) {
      return { state: 'IDLE', isRouting: false };
    }
    return audioService.getRoutingStatus();
  });

  // Audio Routing Start (Phase 5C.2)
  ipcMain.handle(IPC_CHANNELS.ROUTING_START, async (event, options) => {
    if (!isSenderValid(event)) {
      console.warn('[SECURITY] Rejected ROUTING_START from non-main frame');
      return { success: false, state: 'ERROR', error: 'Unauthorized IPC origin' };
    }
    if (!isValidRoutingStartPayload(options)) {
      return { success: false, state: 'ERROR', error: 'Invalid routing start payload' };
    }
    return audioService.startRouting(options);
  });

  // Audio Routing Stop (Phase 5C.2)
  ipcMain.handle(IPC_CHANNELS.ROUTING_STOP, async (event) => {
    if (!isSenderValid(event)) {
      console.warn('[SECURITY] Rejected ROUTING_STOP from non-main frame');
      return { success: false, state: 'ERROR', error: 'Unauthorized IPC origin' };
    }
    return audioService.stopRouting();
  });
}

module.exports = {
  registerIpcHandlers
};
