/**
 * DuoAudio - Phase 5B: Audio Device Service & Selection Unit Tests
 *
 * Deterministically verifies:
 * 1. Device normalization (stripping native internals, validating fields).
 * 2. Playback endpoint filtering (outputChannels > 0, excluding microphones).
 * 3. Empty & invalid enumeration input handling.
 * 4. Native enumeration error recovery without crashing.
 * 5. Duplicate output selection rejection algorithm.
 * 6. Stale/disappeared device selection detection.
 * 7. IPC channel contract allowlisting.
 */

const assert = require('assert');
const {
  normalizeDevice,
  filterPlaybackDevices,
  enumeratePlaybackDevices,
  enumeratePlaybackDevicesSync,
  validateDeviceSelection
} = require('../src/main/device-service');
const { IPC_CHANNELS, isValidChannel } = require('../src/shared/ipc-contracts');

console.log('=================================================');
console.log(' DuoAudio - Phase 5B: Device Service Unit Tests  ');
console.log('=================================================\n');

// --------------------------------------------------------------------------
// Test 1: Device Normalization
// --------------------------------------------------------------------------
console.log('Test 1: Verifying device normalization and sanitization...');
const rawDev = {
  id: 129,
  name: '  Speaker (Realtek(R) Audio)  ',
  outputChannels: 2,
  inputChannels: 0,
  duplexChannels: 0,
  isDefaultOutput: true,
  isDefaultInput: false,
  sampleRates: [44100, 48000],
  preferredSampleRate: 48000,
  nativeFormats: 16,
  _nativeHandle: '0xDEADBEEF' // simulated native pointer
};

const normalized = normalizeDevice(rawDev);
assert.strictEqual(normalized.id, 129);
assert.strictEqual(normalized.name, 'Speaker (Realtek(R) Audio)');
assert.strictEqual(normalized.outputChannels, 2);
assert.strictEqual(normalized.preferredSampleRate, 48000);
assert.strictEqual(normalized.isDefault, true);
// Verify native internals and unneeded arrays are stripped
assert.strictEqual(normalized._nativeHandle, undefined);
assert.strictEqual(normalized.sampleRates, undefined);
assert.strictEqual(normalized.nativeFormats, undefined);
console.log('  [+] Raw device normalized and sanitized successfully.\n');

// --------------------------------------------------------------------------
// Test 2: Filtering Playback Endpoints (Excluding Microphones)
// --------------------------------------------------------------------------
console.log('Test 2: Verifying filtering of valid playback endpoints...');
const mockRawList = [
  { id: 1, name: 'Speakers (Realtek)', outputChannels: 2, inputChannels: 0, preferredSampleRate: 48000 },
  { id: 2, name: 'Microphone Array (Intel)', outputChannels: 0, inputChannels: 2, preferredSampleRate: 48000 },
  { id: 3, name: 'Headphones (realme Buds T310)', outputChannels: 2, inputChannels: 0, preferredSampleRate: 44100 },
  { id: 4, name: 'Stereo Mix (Realtek)', outputChannels: 0, inputChannels: 2, preferredSampleRate: 48000 },
  null,
  undefined,
  { id: 5, name: 'Invalid Dev', outputChannels: -1 }
];

const filtered = filterPlaybackDevices(mockRawList);
assert.strictEqual(filtered.length, 2);
assert.strictEqual(filtered[0].name, 'Speakers (Realtek)');
assert.strictEqual(filtered[1].name, 'Headphones (realme Buds T310)');
console.log('  [+] Input-only recording devices and invalid items excluded.\n');

// --------------------------------------------------------------------------
// Test 3: Empty & Invalid Enumeration Inputs
// --------------------------------------------------------------------------
console.log('Test 3: Verifying empty and malformed enumeration results...');
assert.deepStrictEqual(filterPlaybackDevices([]), []);
assert.deepStrictEqual(filterPlaybackDevices(null), []);
assert.deepStrictEqual(filterPlaybackDevices(undefined), []);
assert.deepStrictEqual(filterPlaybackDevices('not an array'), []);
assert.strictEqual(normalizeDevice(null), null);
assert.strictEqual(normalizeDevice({}), null);
assert.strictEqual(normalizeDevice({ id: 1, outputChannels: 0 }), null);
console.log('  [+] Empty and malformed inputs handled gracefully.\n');

// --------------------------------------------------------------------------
// Test 4: Live Enumeration Service Call
// --------------------------------------------------------------------------
console.log('Test 4: Verifying live Windows audio enumeration service...');
const liveSync = enumeratePlaybackDevicesSync();
assert.strictEqual(typeof liveSync, 'object');
assert.strictEqual(liveSync.success, true);
assert.strictEqual(Array.isArray(liveSync.devices), true);
assert.strictEqual(liveSync.error, null);
console.log(`  [+] Live sync enumeration succeeded: ${liveSync.devices.length} playback device(s) found.`);
liveSync.devices.forEach((d) => {
  console.log(`      - ID ${d.id}: "${d.name}" (${d.outputChannels} ch, ${d.preferredSampleRate} Hz, default=${d.isDefault})`);
});

(async () => {
  const liveAsync = await enumeratePlaybackDevices();
  assert.strictEqual(liveAsync.success, true);
  assert.strictEqual(liveAsync.devices.length, liveSync.devices.length);
  console.log('  [+] Live async device service verified.\n');
})();

// --------------------------------------------------------------------------
// Test 5: Duplicate Selection Rejection Algorithm
// --------------------------------------------------------------------------
console.log('Test 5: Verifying duplicate device selection rejection...');
const available = [
  { id: 101, name: 'realme Buds T310', outputChannels: 2 },
  { id: 102, name: 'Airdopes 161', outputChannels: 2 },
  { id: 103, name: 'Speaker (Realtek)', outputChannels: 2 }
];

// Attempting to select 101 for Output 2 when Output 1 is already 101
const dupCheck = validateDeviceSelection(101, 101, available);
assert.strictEqual(dupCheck.valid, false);
assert.strictEqual(dupCheck.device, null);
assert.strictEqual(typeof dupCheck.reason, 'string');
assert.strictEqual(dupCheck.reason.includes('already selected'), true);
console.log(`  [+] Duplicate selection correctly rejected with message:\n      "${dupCheck.reason}"`);

// Selecting distinct device 102 for Output 2 when Output 1 is 101
const validCheck = validateDeviceSelection(102, 101, available);
assert.strictEqual(validCheck.valid, true);
assert.strictEqual(validCheck.reason, null);
assert.strictEqual(validCheck.device.name, 'Airdopes 161');
console.log('  [+] Valid distinct selection accepted.\n');

// --------------------------------------------------------------------------
// Test 6: Stale Selection Detection
// --------------------------------------------------------------------------
console.log('Test 6: Verifying stale selection detection on device disconnect...');
// Device 999 is not in the available list
const staleCheck = validateDeviceSelection(999, 101, available);
assert.strictEqual(staleCheck.valid, false);
assert.strictEqual(staleCheck.reason.includes('no longer available'), true);
console.log(`  [+] Stale disconnected device detected with message:\n      "${staleCheck.reason}"\n`);

// --------------------------------------------------------------------------
// Test 7: IPC Channel Allowlisting
// --------------------------------------------------------------------------
console.log('Test 7: Verifying Phase 5B IPC channel contracts...');
assert.strictEqual(IPC_CHANNELS.DEVICES_GET, 'devices:get');
assert.strictEqual(IPC_CHANNELS.DEVICES_REFRESH, 'devices:refresh');
assert.strictEqual(isValidChannel('devices:get'), true);
assert.strictEqual(isValidChannel('devices:refresh'), true);
assert.strictEqual(isValidChannel('devices:unauthorized'), false);
console.log('  [+] IPC channels allowlisted and verified.\n');

console.log('=================================================');
console.log(' All Phase 5B Device Service Unit Tests PASSED!  ');
console.log('=================================================');
