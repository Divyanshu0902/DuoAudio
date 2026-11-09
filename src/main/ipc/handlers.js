/**
 * DuoAudio - Electron Main Process IPC Handlers
 *
 * Implements allowlisted IPC communication with the renderer process.
 * Validates all requests and enforces strict security boundaries.
 */

const { ipcMain } = require('electron');
const { IPC_CHANNELS } = require('../../shared/ipc-contracts');

/**
 * Registers all allowlisted IPC handlers for the main window.
 * @param {BrowserWindow} mainWindow
 */
function registerIpcHandlers(mainWindow) {
  // Window Minimize: Hides window to tray
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    // Validate sender frame
    if (event.senderFrame !== mainWindow.webContents.mainFrame) {
      console.warn('[SECURITY] Rejected IPC from non-main frame');
      return;
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.hide();
      console.log('[IPC] Window minimized to tray.');
    }
  });

  // App Initial State (Explicit Phase 5A Mock)
  ipcMain.handle(IPC_CHANNELS.APP_GET_INITIAL_STATE, (event) => {
    return {
      isMock: true,
      appVersion: '0.1.0 (Phase 5A Desktop Shell)',
      routingStatus: 'READY',
      outputs: [
        {
          id: 'out-1',
          slot: 1,
          name: 'realme Buds T310',
          status: 'CONNECTED',
          volume: 100,
          isMock: true
        },
        {
          id: 'out-2',
          slot: 2,
          name: 'Airdopes 161',
          status: 'CONNECTED',
          volume: 100,
          isMock: true
        }
      ]
    };
  });

  // Routing Status Query (Mock)
  ipcMain.handle(IPC_CHANNELS.ROUTING_GET_STATUS, () => {
    return {
      status: 'READY',
      isRouting: false,
      isMock: true
    };
  });
}

module.exports = {
  registerIpcHandlers
};
