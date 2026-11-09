/**
 * DuoAudio - IPC Channel Contracts & Payload Validators
 *
 * Defines explicit, allowlisted IPC channel identifiers and validation functions.
 * Ensures that neither renderer nor main process accepts arbitrary channels or malformed payloads.
 */

const IPC_CHANNELS = Object.freeze({
  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',

  // Application state (Mock for Phase 5A)
  APP_GET_INITIAL_STATE: 'app:get-initial-state',
  ROUTING_GET_STATUS: 'routing:get-status'
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

module.exports = {
  IPC_CHANNELS,
  isValidChannel,
  isValidVolumePercent
};
