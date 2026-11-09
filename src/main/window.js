/**
 * DuoAudio - Main Window Manager
 *
 * Creates and configures the frameless BrowserWindow (440x600 default, 380x500 minimum).
 * Implements strict multi-monitor geometry validation and window-bounds persistence
 * in app.getPath('userData')/window-bounds.json.
 */

const { BrowserWindow, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { lifecycle } = require('./lifecycle');

const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 500;
const MAX_WIDTH = 560;
const MAX_HEIGHT = 760;

function getBoundsFilePath() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

/**
 * Checks whether rectangle A intersects rectangle B with at least minOverlap pixels.
 * @param {Rectangle} rectA
 * @param {Rectangle} rectB
 * @param {number} minOverlap
 * @returns {boolean}
 */
function intersects(rectA, rectB, minOverlap = 80) {
  const overlapX = Math.max(0, Math.min(rectA.x + rectA.width, rectB.x + rectB.width) - Math.max(rectA.x, rectB.x));
  const overlapY = Math.max(0, Math.min(rectA.y + rectA.height, rectB.y + rectB.height) - Math.max(rectA.y, rectB.y));
  return overlapX >= minOverlap && overlapY >= minOverlap;
}

/**
 * Loads saved bounds from app.getPath('userData').
 * Verifies intersection against all active display work areas.
 * If invalid or disconnected, centers on the primary display.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function loadValidatedBounds() {
  const filePath = getBoundsFilePath();

  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (
        typeof data.x === 'number' &&
        typeof data.y === 'number' &&
        typeof data.width === 'number' &&
        typeof data.height === 'number'
      ) {
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, data.width));
        const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.height));
        const candidateBounds = { x: data.x, y: data.y, width, height };

        // Verify candidateBounds intersects with at least one active display's workArea
        const displays = screen.getAllDisplays();
        const isVisibleOnAnyDisplay = displays.some((d) => intersects(candidateBounds, d.workArea, 100));

        if (isVisibleOnAnyDisplay) {
          return candidateBounds;
        } else {
          console.log('[WINDOW] Saved bounds are outside all active display work areas; repositioning to primary display.');
        }
      }
    }
  } catch (err) {
    console.warn('[WINDOW] Could not read saved window bounds, using defaults:', err.message);
  }

  // Fallback: center on primary display work area
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const x = Math.round((screenWidth - DEFAULT_WIDTH) / 2) + primaryDisplay.workArea.x;
  const y = Math.round((screenHeight - DEFAULT_HEIGHT) / 2) + primaryDisplay.workArea.y;

  return { x, y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/**
 * Persists the current window bounds to disk.
 * @param {Rectangle} bounds
 */
function saveWindowBounds(bounds) {
  try {
    const filePath = getBoundsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(bounds, null, 2), 'utf8');
  } catch (err) {
    console.warn('[WINDOW] Failed to save window bounds:', err.message);
  }
}

/**
 * Creates and configures the main DuoAudio BrowserWindow.
 * @returns {BrowserWindow}
 */
function createMainWindow() {
  const bounds = loadValidatedBounds();

  const iconPath = path.join(__dirname, '../../assets/app-icon.png');

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    frame: false, // Custom frameless title bar
    titleBarStyle: 'hidden',
    alwaysOnTop: false,
    resizable: true, // Manual resizing enabled
    maximizable: false, // Native maximizing strictly disabled
    fullscreenable: false,
    show: false, // Shown gracefully on ready-to-show
    backgroundColor: '#101012', // Deep near-black background matching visual specification
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: process.env.NODE_ENV === 'development' || process.argv.includes('--dev')
    }
  });

  // Safeguard: Prevent native maximize attempts via keyboard shortcuts or system hooks
  win.on('maximize', (event) => {
    event.preventDefault();
    win.unmaximize();
  });

  // Debounced bounds persistence
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized() && win.isVisible()) {
        saveWindowBounds(win.getBounds());
      }
    }, 500);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);

  // Prevent accidental termination on window close (e.g. Alt+F4)
  win.on('close', (event) => {
    if (!lifecycle.isQuitting) {
      event.preventDefault();
      win.hide();
      console.log('[WINDOW] Close event intercepted: window hidden to tray.');
    }
  });

  // Gracefully show when rendered
  win.once('ready-to-show', () => {
    win.show();
  });

  // Load UI: development URL or built static asset
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    console.log(`[WINDOW] Loading React UI from Vite Dev Server: ${devServerUrl}`);
    win.loadURL(devServerUrl);
  } else {
    const prodHtmlPath = path.join(__dirname, '../../dist/renderer/index.html');
    console.log(`[WINDOW] Loading React UI from static bundle: ${prodHtmlPath}`);
    win.loadFile(prodHtmlPath);
  }

  return win;
}

module.exports = {
  createMainWindow
};
