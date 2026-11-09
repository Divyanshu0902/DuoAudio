/**
 * DuoAudio - Application Lifecycle & Shutdown Coordinator
 *
 * Manages clean shutdown, ensures single-instance integrity, prevents accidental
 * termination during background operation, and provides an abstraction for future
 * audio-pipeline cleanup and confirmation dialogs.
 */

const { app } = require('electron');

class AppLifecycle {
  constructor() {
    this._isQuitting = false;
    this._tray = null;
    this._mainWindow = null;
    this._isRoutingActive = false; // Mock for Phase 5A
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
   * Whether audio routing is currently active (mock false in Phase 5A).
   * @returns {boolean}
   */
  get isRoutingActive() {
    return this._isRoutingActive;
  }

  /**
   * Initiates graceful application shutdown.
   */
  quit() {
    if (this._isQuitting) return;
    this._isQuitting = true;

    console.log('[LIFECYCLE] Initiating clean DuoAudio shutdown...');

    // Teardown system tray
    if (this._tray) {
      try {
        this._tray.destroy();
        this._tray = null;
        console.log('[LIFECYCLE] System tray destroyed cleanly.');
      } catch (err) {
        console.warn('[LIFECYCLE] Error destroying tray:', err.message);
      }
    }

    // Teardown main window
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      try {
        this._mainWindow.destroy();
        this._mainWindow = null;
        console.log('[LIFECYCLE] Main window destroyed cleanly.');
      } catch (err) {
        console.warn('[LIFECYCLE] Error destroying window:', err.message);
      }
    }

    // Final Electron termination
    app.quit();
  }
}

const lifecycle = new AppLifecycle();

module.exports = {
  lifecycle
};
