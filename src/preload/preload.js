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
  DEVICES_GET: 'devices:get',
  DEVICES_REFRESH: 'devices:refresh',
  APP_GET_INITIAL_STATE: 'app:get-initial-state',
  ROUTING_START: 'routing:start',
  ROUTING_STOP: 'routing:stop',
  ROUTING_GET_STATUS: 'routing:get-status',
  ROUTING_STATUS_CHANGED: 'routing:status-changed',
  TRAY_TRIGGER_START: 'tray:trigger-start'
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
   * Retrieves active Windows audio playback endpoints.
   * @returns {Promise<{ success: boolean, devices: Array<Object>, error: string|null }>}
   */
  getAudioDevices: () => {
    return ipcRenderer.invoke(CHANNELS.DEVICES_GET);
  },

  /**
   * Triggers a live re-enumeration of Windows audio playback endpoints.
   * @returns {Promise<{ success: boolean, devices: Array<Object>, error: string|null }>}
   */
  refreshAudioDevices: () => {
    return ipcRenderer.invoke(CHANNELS.DEVICES_REFRESH);
  },

  /**
   * Retrieves the initial UI configuration.
   * @returns {Promise<Object>}
   */
  getInitialState: () => {
    return ipcRenderer.invoke(CHANNELS.APP_GET_INITIAL_STATE);
  },

  /**
   * Initiates dual-output audio routing with specified options.
   * @param {Object} options
   * @param {number} options.device1Id
   * @param {number} options.device2Id
   * @param {number} [options.vol1]
   * @param {number} [options.vol2]
   * @returns {Promise<Object>}
   */
  startRouting: (options) => {
    return ipcRenderer.invoke(CHANNELS.ROUTING_START, options);
  },

  /**
   * Gracefully stops dual-output audio routing.
   * @returns {Promise<Object>}
   */
  stopRouting: () => {
    return ipcRenderer.invoke(CHANNELS.ROUTING_STOP);
  },

  /**
   * Queries the current audio routing status.
   * @returns {Promise<Object>}
   */
  getRoutingStatus: () => {
    return ipcRenderer.invoke(CHANNELS.ROUTING_GET_STATUS);
  },

  /**
   * Subscribes to audio routing status changes.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onRoutingStatusChanged: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    const listener = (_event, status) => {
      callback(status);
    };
    ipcRenderer.on(CHANNELS.ROUTING_STATUS_CHANGED, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ROUTING_STATUS_CHANGED, listener);
    };
  },

  /**
   * Subscribes to start triggers dispatched from the system tray.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onTrayTriggerStart: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    const listener = () => {
      callback();
    };
    ipcRenderer.on(CHANNELS.TRAY_TRIGGER_START, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.TRAY_TRIGGER_START, listener);
    };
  }
});

contextBridge.exposeInMainWorld('duoAudioAPI', duoAudioAPI);
