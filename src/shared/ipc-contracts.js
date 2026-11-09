/**
 * DuoAudio - IPC Channel Contracts & Payload Validators
 *
 * Defines explicit, allowlisted IPC channel identifiers and validation functions.
 * Ensures that neither renderer nor main process accepts arbitrary channels or malformed payloads.
 */

const IPC_CHANNELS = Object.freeze({
  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',

  // Audio Device Enumeration (Phase 5B)
  DEVICES_GET: 'devices:get',
  DEVICES_REFRESH: 'devices:refresh',

  // Application state & Routing (Phase 5C)
  APP_GET_INITIAL_STATE: 'app:get-initial-state',
  ROUTING_START: 'routing:start',
  ROUTING_STOP: 'routing:stop',
  ROUTING_GET_STATUS: 'routing:get-status',
  ROUTING_STATUS_CHANGED: 'routing:status-changed',
  TRAY_TRIGGER_START: 'tray:trigger-start'
});

/**
 * Validates whether a channel string is a known, allowlisted IPC channel.
 * @param {string} channel
 * @returns {boolean}
 */
function isValidChannel(channel) {
  return typeof channel === 'string' && Object.values(IPC_CHANNELS).includes(channel);
}

/**
 * Validates volume input (0 to 100 percentage integer).
 * @param {number} volumePercent
 * @returns {boolean}
 */
function isValidVolumePercent(volumePercent) {
  return (
    typeof volumePercent === 'number' &&
    Number.isInteger(volumePercent) &&
    volumePercent >= 0 &&
    volumePercent <= 100
  );
}

/**
 * Validates routing start request payload.
 * @param {Object} payload
 * @returns {boolean}
 */
function isValidRoutingStartPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const { device1Id, device2Id, vol1, vol2 } = payload;
  if (typeof device1Id !== 'number' || !Number.isInteger(device1Id)) return false;
  if (typeof device2Id !== 'number' || !Number.isInteger(device2Id)) return false;
  if (device1Id === device2Id) return false;
  if (vol1 !== undefined && (typeof vol1 !== 'number' || isNaN(vol1) || vol1 < 0.0 || vol1 > 1.0)) return false;
  if (vol2 !== undefined && (typeof vol2 !== 'number' || isNaN(vol2) || vol2 < 0.0 || vol2 > 1.0)) return false;
  return true;
}

module.exports = {
  IPC_CHANNELS,
  isValidChannel,
  isValidVolumePercent,
  isValidRoutingStartPayload
};
