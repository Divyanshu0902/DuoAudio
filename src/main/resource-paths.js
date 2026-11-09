/**
 * DuoAudio - Electron Main Process Resource Path Resolver (Phase 5D.2B)
 *
 * Runs exclusively in the Electron main process.
 * Resolves paths to application resources, unpacked scripts, and binaries
 * across development and packaged (ASAR) environments.
 *
 * Guarantees that external executables (node.exe, powershell.exe) receive
 * genuine NTFS filesystem paths located in `app.asar.unpacked` rather than
 * virtualized paths inside `app.asar`.
 */

const { app } = require('electron');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../');

/**
 * Returns the absolute filesystem path for an unpacked resource or script.
 * In development: resolves relative to PROJECT_ROOT.
 * In packaged mode: resolves relative to process.resourcesPath/app.asar.unpacked.
 *
 * @param {string} relativePath - Project-relative path (e.g. 'src/audio_runner.js')
 * @returns {string} Absolute on-disk path
 */
function getUnpackedPath(relativePath) {
  if (app && app.isPackaged && process.resourcesPath) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
  }
  return path.resolve(PROJECT_ROOT, relativePath);
}

/**
 * Returns the absolute path to the bundled Node.js executable if running in a packaged app.
 * In development or if not yet bundled: returns null.
 *
 * @returns {string|null}
 */
function getBundledNodePath() {
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'runtime', 'node.exe');
  }
  return null;
}

module.exports = {
  PROJECT_ROOT,
  getUnpackedPath,
  getBundledNodePath
};
