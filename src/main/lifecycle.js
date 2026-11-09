/**
 * DuoAudio - Application Lifecycle & Shutdown Coordinator
 *
 * Manages clean shutdown, ensures single-instance integrity, prevents accidental
 * termination during background operation, and provides an abstraction for future
 * audio-pipeline cleanup and confirmation dialogs.
 */

const { app } = require('electron');
const { audioService } = require('./audio-service');

class AppLifecycle {
  constructor() {
    this._isQuitting = false;
    this._tray = null;
    this._mainWindow = null;
  }

  /**
   * Sets references to main window and tray once created.
   */
  setContext(mainWindow, tray) {
    this._mainWindow = mainWindow;
    this._tray = tray;
  }

  /**
   * Whether the user or system has triggered an explicit application quit.
   * @returns {boolean}
   */
  get isQuitting() {
    return this._isQuitting;
  }

  /**
   * Whether audio routing is currently active.
   * @returns {boolean}
   */
  get isRoutingActive() {
    return audioService.isRouting;
  }

  /**
   * Initiates graceful application shutdown.
   */
  async quit() {
    if (this._isQuitting) return;
    this._isQuitting = true;

    console.log('[LIFECYCLE] Initiating clean DuoAudio shutdown...');

    // 1. Gracefully stop active audio routing child process and restore mute state
    try {
      if (audioService._child !== null || audioService.isRouting || audioService.state === 'STOPPING' || audioService.state === 'STARTING') {
        console.log('[LIFECYCLE] Stopping active audio service before quit...');
        await audioService.stopRouting();
        console.log('[LIFECYCLE] Audio service stopped cleanly.');
      }
    } catch (err) {
      console.warn('[LIFECYCLE] Error stopping audio service on quit:', err.message);
    }

    // 2. Teardown system tray
    if (this._tray) {
      try {
        this._tray.destroy();
        this._tray = null;
        console.log('[LIFECYCLE] System tray destroyed cleanly.');
      } catch (err) {
        console.warn('[LIFECYCLE] Error destroying tray:', err.message);
      }
    }

    // 3. Teardown main window
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      try {
        this._mainWindow.destroy();
        this._mainWindow = null;
        console.log('[LIFECYCLE] Main window destroyed cleanly.');
      } catch (err) {
        console.warn('[LIFECYCLE] Error destroying window:', err.message);
      }
    }

    // 4. Final Electron termination
    app.quit();
  }
}

const lifecycle = new AppLifecycle();

module.exports = {
  lifecycle
};
