/**
 * DuoAudio - Electron Main Process Entry Point
 *
 * Bootstraps the Electron application shell, enforces single-instance locking,
 * initializes window management, system tray, IPC handlers, and coordinates
 * application lifecycle without terminating on window close.
 */

const { app } = require('electron');
const { createMainWindow } = require('./window');
const { createSystemTray } = require('./tray');
const { registerIpcHandlers } = require('./ipc/handlers');
const { lifecycle } = require('./lifecycle');

// Enforce single-instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[MAIN] Another instance of DuoAudio is already running. Exiting.');
  app.quit();
} else {
  let mainWindow = null;
  let tray = null;

  app.on('second-instance', () => {
    // Focus existing window when a second instance tries to launch
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    console.log('=================================================');
    console.log(' DuoAudio - Phase 5A: Desktop Application Shell  ');
    console.log(' Platform : Windows 11 x64                      ');
    console.log(` Runtime  : Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`);
    console.log('=================================================\n');

    // 1. Create main window
    mainWindow = createMainWindow();

    // 2. Create system tray
    tray = createSystemTray(mainWindow);

    // 3. Register IPC communication
    registerIpcHandlers(mainWindow);

    // 4. Register lifecycle context
    lifecycle.setContext(mainWindow, tray);

    console.log('[MAIN] DuoAudio desktop shell initialized successfully.');

    // Automated smoke test mode for testing environments
    if (process.argv.includes('--smoke-test') || process.env.ELECTRON_SMOKE_TEST) {
      console.log('\n[SMOKE TEST] Running automated desktop lifecycle verification...');

      // 1. Verify window instance
      if (!mainWindow || mainWindow.isDestroyed()) {
        console.error('[SMOKE TEST FAILED] Main window was not created.');
        process.exit(1);
      }
      const bounds = mainWindow.getBounds();
      console.log(`[SMOKE TEST] Window dimensions verified: ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y})`);

      // 2. Verify tray instance
      if (!tray || tray.isDestroyed()) {
        console.error('[SMOKE TEST FAILED] System tray was not created.');
        process.exit(1);
      }
      console.log('[SMOKE TEST] System tray verified.');

      // 3. Test minimize/hide to tray
      mainWindow.hide();
      if (mainWindow.isVisible()) {
        console.error('[SMOKE TEST FAILED] Window remained visible after hide().');
        process.exit(1);
      }
      console.log('[SMOKE TEST] Window hide to tray verified (isVisible === false).');

      // 4. Test single-click restore from tray
      tray.emit('click');
      if (!mainWindow.isVisible()) {
        console.error('[SMOKE TEST FAILED] Window failed to restore on tray single-click.');
        process.exit(1);
      }
      console.log('[SMOKE TEST] Tray single-click restore verified (isVisible === true).');

      // 5. Verify single-click does NOT toggle (must never hide already visible window)
      tray.emit('click');
      if (!mainWindow.isVisible()) {
        console.error('[SMOKE TEST FAILED] Tray single-click erroneously hid visible window.');
        process.exit(1);
      }
      console.log('[SMOKE TEST] Tray single-click non-toggling verified (remains visible).');

      // 6. Verify double-click also restores and never toggles
      tray.emit('double-click');
      if (!mainWindow.isVisible()) {
        console.error('[SMOKE TEST FAILED] Tray double-click erroneously hid visible window.');
        process.exit(1);
      }
      console.log('[SMOKE TEST] Tray double-click idempotency verified (remains visible).');

      console.log('[SMOKE TEST PASSED] All desktop lifecycle operations verified successfully.\n');

      setTimeout(() => {
        lifecycle.quit();
      }, 500);
    }
  });

  // Keep application alive in tray when windows are closed/hidden
  app.on('window-all-closed', () => {
    // In DuoAudio, the application resides in the system tray.
    // We intentionally do not call app.quit() here.
  });

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
      lifecycle.setContext(mainWindow, tray);
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
