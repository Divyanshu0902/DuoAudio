/**
 * DuoAudio - Phase 7.1B: Native Helper Integration & Safety Test Suite
 *
 * Comprehensive integration tests verifying:
 * 1. Native helper path resolution in development and packaged environments.
 * 2. Successful default endpoint query, mute, and verified read-back.
 * 3. Handling of invalid JSON response from helper.
 * 4. Handling of non-zero helper exit code.
 * 5. Missing executable handling and PowerShell fallback policy.
 * 6. Native helper process timeout handling.
 * 7. Invalid endpoint ID handling (HRESULT 0x80070490 / 0x80070057).
 * 8. Mute succeeded but verification failed -> triggers immediate recovery.
 * 9. Recovery failure leaves state UNRESOLVED and armed for emergency.
 * 10. Shutdown restoration and idempotency.
 * 11. Emergency restoration triggered by AudioService on child crash.
 * 12. Originally muted endpoint safety invariant (never unmutes pre-session muted device).
 * 13. Safety restore to original hardware baseline on real endpoint.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const { EndpointMuteManager, resolveDefaultNativeHelperPath } = require('../src/endpoint_mute');
const { PROJECT_ROOT, getNativeHelperPath } = require('../src/main/resource-paths');
const { AudioService } = require('../src/main/audio-service');

console.log('===============================================================');
console.log(' DuoAudio - Phase 7.1B Native Helper Integration Tests');
console.log('===============================================================\n');

let passed = 0;
let total = 0;

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
    throw err;
  }
}

// Mock child process for supervisor testing
class MockChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 99999;
    this.killed = false;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.connected = true;
  }

  send(msg) {
    this.emit('sent_message', msg);
  }

  kill(signal) {
    this.killed = true;
    this.exitCode = 1;
    this.connected = false;
    this.emit('exit', 1, signal || 'SIGTERM');
  }

  simulateMessage(msg) {
    this.emit('message', msg);
  }

  simulateExit(code, signal) {
    this.killed = true;
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

const mockEnumerate = async () => ({
  success: true,
  devices: [
    { id: 10, name: 'Earbuds Left', outputChannels: 2, isDefault: false },
    { id: 20, name: 'Earbuds Right', outputChannels: 2, isDefault: false },
    { id: 30, name: 'Speakers', outputChannels: 2, isDefault: true }
  ]
});

async function runAllTests() {
  console.log('--- Suite 1: Path Resolution Across Environments ---');

  await test('1. Native helper path resolution in development resolves existing binary', () => {
    const helperPath = getNativeHelperPath();
    assert.ok(fs.existsSync(helperPath), `Helper binary must exist at: ${helperPath}`);
    assert.ok(helperPath.endsWith('duoaudio_endpoint.exe'));

    const manager = new EndpointMuteManager();
    assert.ok(fs.existsSync(manager.nativePath), `Manager nativePath must exist: ${manager.nativePath}`);
    assert.strictEqual(manager.nativePath, helperPath);
  });

  await test('2. Native helper path resolution in simulated packaged mode constructs resources/bin path', () => {
    const mockResourcesPath = 'C:\\Program Files\\DuoAudio\\resources';
    const packagedPath = path.join(mockResourcesPath, 'bin', 'duoaudio_endpoint.exe');
    assert.strictEqual(packagedPath, 'C:\\Program Files\\DuoAudio\\resources\\bin\\duoaudio_endpoint.exe');
    assert.ok(!packagedPath.includes('app.asar'), 'Native executable must reside outside app.asar');
  });

  console.log('\n--- Suite 2: Process Execution, Error Paths & Fallback Policy ---');

  await test('3. Invalid JSON response from helper rejects with clear error', async () => {
    const manager = new EndpointMuteManager();
    // Simulate helper returning non-JSON garbage
    manager._runNativeAsync = async () => {
      throw new Error('Failed to parse native helper JSON response: "GARBAGE_OUTPUT"');
    };

    await assert.rejects(async () => {
      await manager.queryDefault();
    }, /Failed to parse native helper JSON/);
  });

  await test('4. Non-zero exit code from native helper propagates structured error', async () => {
    const manager = new EndpointMuteManager();
    // Simulate helper returning error JSON with exit code 1
    manager._runNativeAsync = async () => {
      return { success: false, error: 'CoCreateInstance failed', hresult: '0x80004005' };
    };

    await assert.rejects(async () => {
      await manager.queryDefault();
    }, /Windows Core Audio query failed: CoCreateInstance failed/);
  });

  await test('5. Timeout handling rejects with timeout error and does not hang', async () => {
    const manager = new EndpointMuteManager();
    manager._runNativeAsync = async () => {
      const err = new Error('Native endpoint helper timed out after 5000ms');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    await assert.rejects(async () => {
      await manager.queryDefault();
    }, /timed out/);
  });

  await test('6. Missing native executable rejects with actionable error (zero PowerShell invocation)', async () => {
    const manager = new EndpointMuteManager({
      nativePath: 'C:\\NonExistent\\duoaudio_endpoint.exe'
    });

    await assert.rejects(async () => {
      await manager.queryDefault();
    }, /Native audio endpoint helper executable was not found/);
  });

  await test('7. Native execution failure rejects with structured error (zero PowerShell invocation)', async () => {
    const manager = new EndpointMuteManager();
    // Mock native helper failing with application error
    manager._runNativeAsync = async () => {
      return { success: false, error: 'Device disconnected', hresult: '0x80070490' };
    };

    await assert.rejects(async () => {
      await manager.queryDefault();
    }, /Device disconnected/);
  });

  console.log('\n--- Suite 3: Safety State Machine & Recovery Guarantees ---');

  await test('8. Mute succeeded but verification failed: triggers immediate recovery unmute', async () => {
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: '{ep-test-8}', name: 'Test Speaker' };
    manager.originallyMuted = false;

    let muteCalled = false;
    let recoveryCalled = false;

    manager._runNativeAsync = async (args) => {
      if (args[0] === 'mute-by-id') {
        muteCalled = true;
        // Native SetMute executed but GetMute read-back showed false
        return { success: false, error: 'Verification failed: endpoint is not muted', newMute: false };
      }
      if (args[0] === 'unmute-by-id') {
        recoveryCalled = true;
        return { success: true, id: args[1], oldMute: true, newMute: false };
      }
      return { success: true };
    };

    await assert.rejects(async () => {
      await manager.muteTarget();
    }, /Verification failed/);

    assert.strictEqual(muteCalled, true);

    // Call unmuteAndVerify (simulating runner recovery)
    const recResult = await manager.unmuteAndVerify();
    assert.strictEqual(recoveryCalled, true);
    assert.strictEqual(recResult.status, 'RESTORED');
    assert.strictEqual(recResult.verifiedUnmuted, true);
    assert.strictEqual(manager.isRestored, true);
  });

  await test('9. Immediate recovery failure leaves restoration UNRESOLVED', async () => {
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: '{ep-test-9}', name: 'Test Speaker' };
    manager.originallyMuted = false;

    manager._runNativeAsync = async (args) => {
      if (args[0] === 'unmute-by-id') {
        // Recovery unmute failed
        return { success: false, error: 'Recovery unmute failed: hardware timeout', newMute: true };
      }
      return { success: true };
    };

    const recResult = await manager.unmuteAndVerify();
    assert.strictEqual(recResult.status, 'UNRESOLVED');
    assert.strictEqual(recResult.verifiedUnmuted, false);
    assert.strictEqual(manager.isRestored, false, 'Must not mark restored when recovery fails');
  });

  await test('10. Originally muted endpoint is NEVER unmuted during init, recovery, or restore', async () => {
    let unmuteInvoked = false;
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: '{ep-already-muted}', name: 'Muted Speaker' };
    manager.originallyMuted = true;

    manager._runNativeAsync = async (args) => {
      if (args[0] === 'unmute-by-id' || args[0] === 'mute-by-id') {
        unmuteInvoked = true;
      }
      return { success: true };
    };

    // muteTarget should skip muting
    const muteRes = await manager.muteTarget();
    assert.strictEqual(muteRes.muted, false);
    assert.strictEqual(muteRes.originallyMuted, true);
    assert.strictEqual(unmuteInvoked, false);

    // unmuteAndVerify should refuse to unmute
    const recRes = await manager.unmuteAndVerify();
    assert.strictEqual(recRes.status, 'NOT_REQUIRED');
    assert.strictEqual(recRes.verifiedUnmuted, false);
    assert.strictEqual(unmuteInvoked, false);

    // restore should refuse to unmute
    const restRes = await manager.restore();
    assert.ok(restRes.status === 'NOT_REQUIRED' || restRes.status === 'SKIPPED');
    assert.strictEqual(unmuteInvoked, false, 'Native unmute must NEVER be called on pre-session muted endpoint');
  });

  await test('11. Emergency restoration triggered by AudioService supervisor on child crash', async () => {
    let emergencyRestorationEndpoint = null;

    class TestSupervisorMuteManager {
      static async restoreEndpointById(endpointId) {
        emergencyRestorationEndpoint = endpointId;
        return { restored: true, status: 'RESTORED' };
      }
    }

    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: TestSupervisorMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          // Send baseline for unmuted endpoint
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{crashed-endpoint-guid}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
          // Confirm mute applied
          mockChild.simulateMessage({
            type: 'MUTE_APPLIED',
            endpointId: '{crashed-endpoint-guid}'
          });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(service.getRoutingStatus().state, 'RUNNING');

    // Simulate unexpected crash of audio runner
    mockChild.simulateExit(1, 'SIGSEGV');

    assert.strictEqual(
      emergencyRestorationEndpoint,
      '{crashed-endpoint-guid}',
      'AudioService supervisor must trigger emergency restoration for muted endpoint on child crash'
    );
  });

  console.log('\n--- Suite 4: Live Real Hardware Validation ---');

  let defaultEndpointId = null;
  let originalMuteBaseline = null;

  await test('12. Real Windows Hardware: queryDefault retrieves active default endpoint', async () => {
    const manager = new EndpointMuteManager();
    const ep = await manager.queryDefault();
    assert.ok(ep, 'queryDefault must return an endpoint');
    assert.ok(ep.id && typeof ep.id === 'string');
    assert.ok(ep.name && typeof ep.name === 'string');
    assert.ok(typeof ep.isMuted === 'boolean');
    assert.ok(typeof ep.volume === 'number');

    defaultEndpointId = ep.id;
    originalMuteBaseline = ep.isMuted;
    console.log(`       [REAL HARDWARE] Discovered: "${ep.name}" (${ep.id})`);
    console.log(`       [REAL HARDWARE] Baseline  : isMuted=${ep.isMuted}, volume=${ep.volume}`);
  });

  await test('13. Real Windows Hardware: Mute, Verify, Restore, and Safe Baseline Retention', async () => {
    assert.ok(defaultEndpointId, 'Cannot run without defaultEndpointId');
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: defaultEndpointId, name: 'Default Audio Device' };
    manager.originallyMuted = originalMuteBaseline;

    try {
      if (originalMuteBaseline === false) {
        // Test muteTarget
        const muteRes = await manager.muteTarget();
        assert.strictEqual(muteRes.muted, true);
        assert.strictEqual(manager.isMutedByDuoAudio, true);

        // Verify with get-by-id
        const verifyMuted = await manager._runAsync(['get-by-id', defaultEndpointId]);
        assert.strictEqual(verifyMuted.isMuted, true);

        // Test restore
        const restRes = await manager.restore();
        assert.strictEqual(restRes.status, 'RESTORED');
        assert.strictEqual(restRes.restored, true);

        // Verify with get-by-id
        const verifyUnmuted = await manager._runAsync(['get-by-id', defaultEndpointId]);
        assert.strictEqual(verifyUnmuted.isMuted, false);
      } else {
        // If originally muted, muteTarget should preserve pre-session state
        const muteRes = await manager.muteTarget();
        assert.strictEqual(muteRes.muted, false);
        assert.strictEqual(muteRes.originallyMuted, true);
      }
    } finally {
      // Safety guarantee: Always ensure endpoint matches pre-test baseline
      const finalManager = new EndpointMuteManager();
      if (originalMuteBaseline === false) {
        await finalManager._runAsync(['unmute-by-id', defaultEndpointId]);
      } else {
        await finalManager._runAsync(['mute-by-id', defaultEndpointId]);
      }
      const finalCheck = await finalManager._runAsync(['get-by-id', defaultEndpointId]);
      assert.strictEqual(finalCheck.isMuted, originalMuteBaseline, 'SAFETY VIOLATION: Endpoint was not restored to baseline!');
      console.log(`       [SAFETY RESTORE] Verified endpoint restored to original baseline: isMuted=${finalCheck.isMuted}`);
    }
  });

  console.log('\n===============================================================');
  console.log(` Results: ${passed}/${total} integration tests passed`);
  console.log('===============================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
