/**
 * DuoAudio - Windows Audio Device Enumeration Service
 *
 * Runs in the Electron main process.
 * Queries active Windows playback endpoints via an isolated worker process utilizing
 * RtAudio (WASAPI backend) from audify. This guarantees native ABI safety, non-blocking
 * IPC responses, and zero crash propagation to the Electron application shell.
 */

const { execFile, execFileSync } = require('child_process');
const path = require('path');
const { resolveSystemNode } = require('./node-resolver');
const { getUnpackedPath } = require('./resource-paths');

/**
 * Normalizes a raw RtAudio device descriptor into an explicit, sanitized object.
 * @param {Object} rawDev
 * @returns {Object|null}
 */
function normalizeDevice(rawDev) {
  if (!rawDev || typeof rawDev !== 'object') {
    return null;
  }

  // Must have a valid identifier and at least one playback channel
  if (rawDev.id === undefined || typeof rawDev.outputChannels !== 'number' || rawDev.outputChannels <= 0) {
    return null;
  }

  return {
    id: rawDev.id,
    name: typeof rawDev.name === 'string' && rawDev.name.trim().length > 0
      ? rawDev.name.trim()
      : `Audio Endpoint ${rawDev.id}`,
    outputChannels: rawDev.outputChannels,
    preferredSampleRate: typeof rawDev.preferredSampleRate === 'number' && rawDev.preferredSampleRate > 0
      ? rawDev.preferredSampleRate
      : 48000,
    isDefault: Boolean(rawDev.isDefaultOutput || rawDev.isDefault)
  };
}

/**
 * Filters a list of raw devices for valid playback endpoints and normalizes them.
 * @param {Array} rawDevices
 * @returns {Array<Object>}
 */
function filterPlaybackDevices(rawDevices) {
  if (!Array.isArray(rawDevices)) {
    return [];
  }

  return rawDevices
    .map(normalizeDevice)
    .filter((dev) => dev !== null);
}

/**
 * Asynchronously enumerates active Windows playback endpoints.
 * @returns {Promise<{ success: boolean, devices: Array<Object>, error: string|null }>}
 */
function enumeratePlaybackDevices() {
  return new Promise((resolve) => {
    const workerPath = getUnpackedPath('src/main/enumerate-worker.js');
    const nodeRes = resolveSystemNode();
    if (!nodeRes.success || !nodeRes.nodePath) {
      console.error('[DEVICE-SERVICE] Device enumeration failed: Node.js runtime resolution failed:', nodeRes.error);
      return resolve({
        success: false,
        devices: [],
        error: nodeRes.error || 'Failed to locate compatible Node.js runtime for device enumeration.'
      });
    }

    const nodeExe = nodeRes.nodePath;
    execFile(nodeExe, [workerPath], { timeout: 5000, cwd: path.dirname(workerPath) }, (err, stdout, stderr) => {
      if (err) {
        console.error('[DEVICE-SERVICE] Device enumeration failed:', err.message, stderr);
        return resolve({
          success: false,
          devices: [],
          error: err.message || (stderr && stderr.toString()) || 'Audio device enumeration failed.'
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        const rawList = Array.isArray(parsed.devices) ? parsed.devices : [];
        const sanitized = filterPlaybackDevices(rawList);
        return resolve({
          success: true,
          devices: sanitized,
          error: null
        });
      } catch (parseErr) {
        console.error('[DEVICE-SERVICE] Failed to parse worker output:', parseErr.message);
        return resolve({
          success: false,
          devices: [],
          error: 'Malformed enumeration output from audio backend.'
        });
      }
    });
  });
}

/**
 * Synchronous variant of device enumeration for deterministic testing.
 * @returns {{ success: boolean, devices: Array<Object>, error: string|null }}
 */
function enumeratePlaybackDevicesSync() {
  const workerPath = getUnpackedPath('src/main/enumerate-worker.js');
  const nodeRes = resolveSystemNode();
  if (!nodeRes.success || !nodeRes.nodePath) {
    return {
      success: false,
      devices: [],
      error: nodeRes.error || 'Failed to locate compatible Node.js runtime for device enumeration.'
    };
  }

  const nodeExe = nodeRes.nodePath;
  try {
    const stdout = execFileSync(nodeExe, [workerPath], { timeout: 5000, encoding: 'utf8', cwd: path.dirname(workerPath) });
    const parsed = JSON.parse(stdout);
    const rawList = Array.isArray(parsed.devices) ? parsed.devices : [];
    const sanitized = filterPlaybackDevices(rawList);
    return {
      success: true,
      devices: sanitized,
      error: null
    };
  } catch (err) {
    return {
      success: false,
      devices: [],
      error: err.message || 'Synchronous enumeration failed.'
    };
  }
}

/**
 * Validates a candidate device selection for an output slot against the other output slot.
 * Ensures duplicate assignments to the same physical device are rejected.
 *
 * @param {number|string|null} candidateId
 * @param {number|string|null} otherSlotId
 * @param {Array<Object>} availableDevices
 * @returns {{ valid: boolean, reason: string|null, device: Object|null }}
 */
function validateDeviceSelection(candidateId, otherSlotId, availableDevices) {
  if (candidateId === null || candidateId === undefined) {
    return { valid: true, reason: null, device: null };
  }

  // Reject duplicate endpoint assignment
  if (otherSlotId !== null && otherSlotId !== undefined && candidateId === otherSlotId) {
    const assignedDev = Array.isArray(availableDevices)
      ? availableDevices.find((d) => d && d.id === candidateId)
      : null;
    const name = assignedDev ? assignedDev.name : `Endpoint ${candidateId}`;
    return {
      valid: false,
      reason: `"${name}" is already selected for the other output. Dual routing requires two distinct endpoints.`,
      device: null
    };
  }

  // Verify device exists in currently available devices
  const found = Array.isArray(availableDevices)
    ? availableDevices.find((d) => d && d.id === candidateId)
    : null;

  if (!found) {
    return {
      valid: false,
      reason: `Selected audio endpoint (ID: ${candidateId}) is no longer available.`,
      device: null
    };
  }

  return {
    valid: true,
    reason: null,
    device: found
  };
}

module.exports = {
  normalizeDevice,
  filterPlaybackDevices,
  enumeratePlaybackDevices,
  enumeratePlaybackDevicesSync,
  validateDeviceSelection
};
