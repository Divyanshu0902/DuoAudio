/**
 * DuoAudio - Secure Electron Preload Script
 *
 * Runs in an isolated context with sandbox: true, contextIsolation: true, nodeIntegration: false.
 * Exposes only a strictly allowlisted, purpose-built API on window.duoAudioAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Channel constants defined locally to allow sandbox: true without module-resolution failures
const CHANNELS = Object.freeze({
  WINDOW_MINIMIZE: 'window:minimize',
  APP_GET_INITIAL_STATE: 'app:get-initial-state',
  ROUTING_GET_STATUS: 'routing:get-status'
});

const duoAudioAPI = Object.freeze({
  /**
   * Requests the main process to minimize the window (hides to tray).
   * @returns {Promise<void>}
   */
  minimizeWindow: () => {
    return ipcRenderer.invoke(CHANNELS.WINDOW_MINIMIZE);
  },

  /**
   * Retrieves the initial UI configuration and mock device status.
   * @returns {Promise<Object>}
   */
  getInitialState: () => {
    return ipcRenderer.invoke(CHANNELS.APP_GET_INITIAL_STATE);
  },

  /**
   * Queries the current mock routing status.
   * @returns {Promise<Object>}
   */
  getRoutingStatus: () => {
    return ipcRenderer.invoke(CHANNELS.ROUTING_GET_STATUS);
  }
});

contextBridge.exposeInMainWorld('duoAudioAPI', duoAudioAPI);
