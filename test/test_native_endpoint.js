/**
 * DuoAudio - Phase 7.1A: Native Windows Audio Endpoint Helper Test Suite
 *
 * Verifies:
 * 1. Binary existence and execution.
 * 2. Strict CLI validation, non-zero exit codes, and stdout JSON purity on error paths.
 * 3. HRESULT error reporting on invalid or disconnected endpoint GUIDs.
 * 4. Live Windows Core Audio query against actual hardware (query-default, get-by-id).
 * 5. Full mute, read-back verification, unmute, and safe state restoration cycle.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

console.log('===============================================================');
console.log(' DuoAudio - Phase 7.1A: Native Audio Endpoint Helper Tests');
console.log('===============================================================\n');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BINARY_PATH = path.join(PROJECT_ROOT, 'duoaudio_endpoint.exe');

let passed = 0;
let total = 0;

function runHelper(args) {
  return new Promise((resolve) => {
    execFile(BINARY_PATH, args, { windowsHide: true }, (err, stdout, stderr) => {
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse((stdout || '').trim());
      } catch (e) {
        parseError = e.message;
      }
      resolve({
        exitCode: err ? (err.code || 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        json: parsed,
        parseError
      });
    });
  });
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  [+] PASS: ${name}`);
  } catch (err) {
    console.error(`  [-] FAIL: ${name}`);
    console.error(`      Error: ${err.message}`);
    process.exitCode = 1;
  }
}

async function runAllTests() {
  // Check binary existence
  assert.ok(fs.existsSync(BINARY_PATH), `Binary not found at: ${BINARY_PATH}. Run scripts/build-native-helper.bat first.`);

  console.log('--- Suite 1: Automated CLI Validation & Error Paths ---');

  await test('Execution without arguments exits with code 1 and valid error JSON', async () => {
    const res = await runHelper([]);
    assert.strictEqual(res.exitCode, 1, 'Expected exit code 1 for no args');
    assert.strictEqual(res.parseError, null, 'stdout must be strictly parseable JSON');
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.error.includes('No action specified'));
    assert.ok(res.stderr.length > 0, 'Diagnostics should be emitted to stderr');
  });

  await test('Execution with invalid action exits with code 1 and valid error JSON', async () => {
    const res = await runHelper(['invalid-action']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.error.includes('Invalid action'));
  });

  await test('Missing endpoint ID for mute-by-id exits with code 1', async () => {
    const res = await runHelper(['mute-by-id']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.error.includes('No endpoint ID'));
  });

  await test('Missing endpoint ID for unmute-by-id exits with code 1', async () => {
    const res = await runHelper(['unmute-by-id']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.error.includes('No endpoint ID'));
  });

  await test('Missing endpoint ID for get-by-id exits with code 1', async () => {
    const res = await runHelper(['get-by-id']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.error.includes('No endpoint ID'));
  });

  await test('Invalid/non-existent endpoint GUID returns exit code 1 with HRESULT 0x80070490', async () => {
    const res = await runHelper(['get-by-id', '{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.hresult.includes('80070490'), `Expected HRESULT 80070490, got: ${res.json.hresult}`);
  });

  await test('Malformed endpoint ID string returns exit code 1 with HRESULT', async () => {
    const res = await runHelper(['mute-by-id', 'malformed_guid_string']);
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, false);
    assert.ok(res.json.hresult, 'Expected HRESULT on malformed device ID');
  });

  console.log('\n--- Suite 2: Live Windows Audio Hardware Validation ---');

  let defaultEndpointId = null;
  let originalMuteState = null;

  await test('query-default returns active Windows playback endpoint with metadata', async () => {
    const res = await runHelper(['query-default']);
    assert.strictEqual(res.exitCode, 0, `query-default failed: ${res.stderr}`);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, true);
    assert.ok(typeof res.json.id === 'string' && res.json.id.length > 0, 'Endpoint ID must be non-empty string');
    assert.ok(typeof res.json.name === 'string' && res.json.name.length > 0, 'Friendly name must be non-empty string');
    assert.ok(typeof res.json.isMuted === 'boolean', 'isMuted must be boolean');
    assert.ok(typeof res.json.volume === 'number' && !isNaN(res.json.volume), 'volume must be valid float');

    defaultEndpointId = res.json.id;
    originalMuteState = res.json.isMuted;
    console.log(`       [HARDWARE] Default endpoint: "${res.json.name}" (${res.json.id})`);
    console.log(`       [HARDWARE] Original state : isMuted=${res.json.isMuted}, volume=${res.json.volume}`);
  });

  await test('get-by-id matches query-default baseline for discovered endpoint', async () => {
    assert.ok(defaultEndpointId, 'Cannot run without discovered default endpoint');
    const res = await runHelper(['get-by-id', defaultEndpointId]);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.parseError, null);
    assert.strictEqual(res.json.success, true);
    assert.strictEqual(res.json.id, defaultEndpointId);
    assert.strictEqual(res.json.isMuted, originalMuteState);
  });

  await test('Hardware Mute, Read-back Verification, Unmute, and Restoration Cycle', async () => {
    assert.ok(defaultEndpointId, 'Cannot run without discovered default endpoint');
    try {
      // 1. Mute target
      const muteRes = await runHelper(['mute-by-id', defaultEndpointId]);
      assert.strictEqual(muteRes.exitCode, 0, `mute-by-id failed: ${muteRes.stderr}`);
      assert.strictEqual(muteRes.json.success, true);
      assert.strictEqual(muteRes.json.newMute, true);

      // 2. Independently verify muted state via get-by-id
      const verifyMuted = await runHelper(['get-by-id', defaultEndpointId]);
      assert.strictEqual(verifyMuted.exitCode, 0);
      assert.strictEqual(verifyMuted.json.isMuted, true, 'get-by-id must confirm endpoint is muted');

      // 3. Unmute target
      const unmuteRes = await runHelper(['unmute-by-id', defaultEndpointId]);
      assert.strictEqual(unmuteRes.exitCode, 0, `unmute-by-id failed: ${unmuteRes.stderr}`);
      assert.strictEqual(unmuteRes.json.success, true);
      assert.strictEqual(unmuteRes.json.newMute, false);

      // 4. Independently verify unmuted state via get-by-id
      const verifyUnmuted = await runHelper(['get-by-id', defaultEndpointId]);
      assert.strictEqual(verifyUnmuted.exitCode, 0);
      assert.strictEqual(verifyUnmuted.json.isMuted, false, 'get-by-id must confirm endpoint is unmuted');
    } finally {
      // Safety guarantee: Restore endpoint to its original pre-test state
      if (originalMuteState !== null) {
        const restoreAction = originalMuteState ? 'mute-by-id' : 'unmute-by-id';
        const finalRestore = await runHelper([restoreAction, defaultEndpointId]);
        const finalVerify = await runHelper(['get-by-id', defaultEndpointId]);
        assert.strictEqual(finalVerify.json.isMuted, originalMuteState, 'Safety restoration failed!');
        console.log(`       [SAFETY RESTORE] Verified endpoint restored to original baseline: isMuted=${finalVerify.json.isMuted}`);
      }
    }
  });

  console.log('\n===============================================================');
  console.log(` Results: ${passed}/${total} tests passed`);
  console.log('===============================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
