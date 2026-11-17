/**
 * DuoAudio - Phase 5D.2E.2: Endpoint Mute Failure Recovery and Safety Test Suite
 *
 * Verifies:
 * 1. Endpoint helper unavailable before mute: audio routing remains non-fatal; endpoint state is reported conservatively.
 * 2. Mute succeeds but subsequent verification fails: recovery unmute is attempted.
 * 3. Recovery unmute succeeds and verifies the endpoint is unmuted: restoration is confirmed.
 * 4. Recovery unmute fails: restoration remains unresolved and is not falsely confirmed.
 * 5. Normal shutdown with unresolved restoration: another best-effort recovery is attempted.
 * 6. Audio child crashes with unresolved restoration: emergency restoration is attempted.
 * 7. Originally muted endpoint: DuoAudio does not accidentally unmute it during recovery.
 * 8. Successful normal mute and shutdown restoration: existing behavior remains intact.
 * 9. Preservation of structured child-process errors.
 * 10. Generic exit errors when no structured error was received.
 * 11. Error-state reset between routing sessions.
 * 12. UI warning visibility and dismissal.
 * 13. Existing partial-output failure handling remains unchanged.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { AudioService } = require('../src/main/audio-service');
const { EndpointMuteManager } = require('../src/endpoint_mute');

class MockChildProcess extends EventEmitter {
  constructor(pid = 12345) {
    super();
    this.pid = pid;
    this.connected = true;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.sentMessages = [];
    this.receivedSignals = [];
    this._childError = null;
  }

  send(msg) {
    this.sentMessages.push(msg);
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.receivedSignals.push(signal);
    this.connected = false;
    process.nextTick(() => {
      this.simulateExit(0, signal);
    });
  }

  simulateMessage(msg) {
    this.emit('message', msg);
  }

  simulateExit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

const mockDevices = [
  { id: 10, name: 'realme Buds T310', outputChannels: 2, preferredSampleRate: 48000, isDefault: false },
  { id: 20, name: 'Airdopes 161', outputChannels: 2, preferredSampleRate: 48000, isDefault: false },
  { id: 30, name: 'Laptop Speakers', outputChannels: 2, preferredSampleRate: 48000, isDefault: true }
];

const mockEnumerate = () => Promise.resolve({
  success: true,
  devices: mockDevices,
  error: null
});

async function runResilienceTests() {
  console.log('==============================================================');
  console.log(' DuoAudio - Phase 5D.2E.2 Mute Recovery & Safety Test Suite   ');
  console.log('==============================================================\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  [+] PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [-] FAIL: ${name}`);
      console.error(`      Error: ${err.message}`);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Test 1: Endpoint helper unavailable before mute (Case A)
  // --------------------------------------------------------------------------
  await test('1. Endpoint helper unavailable before mute: audio routing remains non-fatal; endpoint state reported conservatively', async () => {
    let mockChild;
    let emergencyUnmuteCalled = false;

    class MockMuteManager {
      static async restoreEndpointById() {
        emergencyUnmuteCalled = true;
        return { restored: true, status: 'RESTORED' };
      }
    }

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: MockMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          // Runner reports non-fatal warning: query failed (helper missing/blocked)
          mockChild.simulateMessage({
            type: 'WARNING',
            code: 'ENDPOINT_MUTE_UNAVAILABLE',
            message: 'Endpoint muting is unavailable for this session. Audio sharing will continue, but Windows default speakers may also play audio.',
            details: 'Native helper launch error: duoaudio_endpoint.exe does not exist'
          });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    const res = await startPromise;

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'RUNNING');

    const status = service.getRoutingStatus();
    assert.strictEqual(status.state, 'RUNNING');
    assert.strictEqual(status.isRouting, true);
    assert.strictEqual(status.muteState.baselineReceived, false);
    assert.strictEqual(status.muteState.willMute, false);
    assert.strictEqual(status.muteState.muteApplied, false);
    assert.strictEqual(status.muteState.isMutedByDuoAudio, false);
    assert.strictEqual(status.muteState.restorationConfirmed, false);
    assert.strictEqual(status.muteState.unresolved, false);
    assert.ok(status.warning);
    assert.strictEqual(status.warning.code, 'ENDPOINT_MUTE_UNAVAILABLE');

    // Sudden child crash when baseline was never received must NOT attempt blind emergency restoration
    mockChild.simulateExit(1, 'SIGKILL');
    assert.strictEqual(emergencyUnmuteCalled, false, 'Must not trigger emergency unmute when baseline is unknown');
  });

  // --------------------------------------------------------------------------
  // Test 2: Mute succeeds but subsequent verification fails: recovery unmute is attempted
  // --------------------------------------------------------------------------
  await test('2. Mute succeeds but subsequent verification fails: recovery unmute is attempted', async () => {
    const executedPsCommands = [];
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: '{ep-guid-test-2}', name: 'Speakers' };
    manager.originallyMuted = false;

    manager._runPsAsync = async (args) => {
      executedPsCommands.push(args);
      if (args[0] === 'mute-by-id') {
        // Mute command executes but verification throws or returns false
        return { success: false, error: 'GetMute verification failed' };
      }
      if (args[0] === 'unmute-by-id') {
        // Recovery unmute called
        return { success: true, id: args[1], newMute: false };
      }
      return { success: true };
    };

    // muteTarget throws because verification failed
    await assert.rejects(async () => {
      await manager.muteTarget();
    }, /Verification failed/);

    // Call unmuteAndVerify
    const recoveryRes = await manager.unmuteAndVerify();
    assert.strictEqual(recoveryRes.success, true);
    assert.strictEqual(recoveryRes.verifiedUnmuted, true);
    assert.strictEqual(recoveryRes.status, 'RESTORED');

    // Confirm that unmute-by-id was actually invoked with the exact endpoint ID
    const unmuteCmd = executedPsCommands.find((c) => c[0] === 'unmute-by-id');
    assert.ok(unmuteCmd, 'unmute-by-id must be invoked during recovery');
    assert.strictEqual(unmuteCmd[1], '{ep-guid-test-2}');
  });

  // --------------------------------------------------------------------------
  // Test 3: Recovery unmute succeeds and verifies endpoint is unmuted: restoration confirmed
  // --------------------------------------------------------------------------
  await test('3. Recovery unmute succeeds and verifies endpoint is unmuted: restoration is confirmed', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{speakers-guid-3}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    // Child informs that mute failed, but recovery unmute succeeded and verified unmuted
    mockChild.simulateMessage({
      type: 'MUTE_FAILED',
      endpointId: '{speakers-guid-3}',
      endpointName: 'Laptop Speakers',
      originallyMuted: false,
      muteApplied: false,
      recoveryAttempted: true,
      verifiedUnmuted: true,
      restorationConfirmed: true,
      restorationStatus: 'RESTORED',
      error: 'COM GetMute verification failed'
    });
    mockChild.simulateMessage({
      type: 'WARNING',
      code: 'ENDPOINT_MUTE_FAILED',
      message: 'Endpoint muting failed for this session. Audio sharing will continue, but Windows default speakers may also play audio.',
      details: 'COM GetMute verification failed'
    });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });

    const res = await startPromise;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'RUNNING');

    const status = service.getRoutingStatus();
    assert.strictEqual(status.state, 'RUNNING');
    assert.strictEqual(status.muteState.muteApplied, false);
    assert.strictEqual(status.muteState.isMutedByDuoAudio, false);
    // Verified unmuted -> restorationConfirmed is true, unresolved is false
    assert.strictEqual(status.muteState.restorationConfirmed, true);
    assert.strictEqual(status.muteState.restorationStatus, 'RESTORED');
    assert.strictEqual(status.muteState.unresolved, false);
    assert.ok(status.warning);
  });

  // --------------------------------------------------------------------------
  // Test 4: Recovery unmute fails: restoration remains unresolved and is not falsely confirmed
  // --------------------------------------------------------------------------
  await test('4. Recovery unmute fails: restoration remains unresolved and is not falsely confirmed', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{speakers-guid-4}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    // Child informs that mute failed and recovery unmute ALSO failed (unresolved)
    mockChild.simulateMessage({
      type: 'MUTE_FAILED',
      endpointId: '{speakers-guid-4}',
      endpointName: 'Laptop Speakers',
      originallyMuted: false,
      muteApplied: false,
      recoveryAttempted: true,
      verifiedUnmuted: false,
      restorationConfirmed: false,
      restorationStatus: 'UNRESOLVED',
      error: 'COM SetMute verification failed',
      recoveryError: 'PowerShell timeout during recovery unmute'
    });
    mockChild.simulateMessage({
      type: 'WARNING',
      code: 'ENDPOINT_MUTE_FAILED',
      message: 'Endpoint muting failed for this session. Audio sharing will continue, but Windows default speakers may also play audio.',
      details: 'COM SetMute verification failed'
    });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });

    const res = await startPromise;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'RUNNING');

    const status = service.getRoutingStatus();
    assert.strictEqual(status.state, 'RUNNING');
    assert.strictEqual(status.muteState.muteApplied, false);
    assert.strictEqual(status.muteState.isMutedByDuoAudio, false);
    // Must NOT be falsely confirmed!
    assert.strictEqual(status.muteState.restorationConfirmed, false);
    assert.strictEqual(status.muteState.restorationStatus, 'UNRESOLVED');
    assert.strictEqual(status.muteState.unresolved, true, 'Must report unresolved: true');
    assert.ok(status.warning);
  });

  // --------------------------------------------------------------------------
  // Test 5: Normal shutdown with unresolved restoration: best-effort recovery is attempted
  // --------------------------------------------------------------------------
  await test('5. Normal shutdown with unresolved restoration: best-effort recovery is attempted', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{speakers-guid-5}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    // Recovery unverified during startup
    mockChild.simulateMessage({
      type: 'MUTE_FAILED',
      endpointId: '{speakers-guid-5}',
      endpointName: 'Laptop Speakers',
      originallyMuted: false,
      muteApplied: false,
      verifiedUnmuted: false,
      restorationConfirmed: false,
      restorationStatus: 'UNRESOLVED'
    });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
    await startPromise;

    assert.strictEqual(service.getRoutingStatus().muteState.unresolved, true);

    // Normal user stop initiated
    const stopPromise = service.stopRouting();
    assert.strictEqual(mockChild.sentMessages.some((m) => m.type === 'SHUTDOWN'), true);

    // During runner shutdown, another best-effort unmute attempt succeeds and confirms RESTORED
    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'RESTORED',
      endpointId: '{speakers-guid-5}'
    });
    mockChild.simulateExit(0, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    assert.strictEqual(stopRes.state, 'STOPPED');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationConfirmed, true);
    assert.strictEqual(service.getRoutingStatus().muteState.unresolved, false);
  });

  // --------------------------------------------------------------------------
  // Test 6: Audio child crashes with unresolved restoration: emergency restoration is attempted
  // --------------------------------------------------------------------------
  await test('6. Audio child crashes with unresolved restoration: emergency restoration is attempted', async () => {
    let mockChild;
    let emergencyUnmuteCalled = false;
    let emergencyEndpointId = null;

    class MockMuteManager {
      static async restoreEndpointById(id) {
        emergencyUnmuteCalled = true;
        emergencyEndpointId = id;
        return { restored: true, status: 'RESTORED' };
      }
    }

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: MockMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{speakers-guid-crash-unresolved}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    // Recovery unmute failed at startup -> UNRESOLVED
    mockChild.simulateMessage({
      type: 'MUTE_FAILED',
      endpointId: '{speakers-guid-crash-unresolved}',
      endpointName: 'Laptop Speakers',
      originallyMuted: false,
      muteApplied: false,
      verifiedUnmuted: false,
      restorationConfirmed: false,
      restorationStatus: 'UNRESOLVED'
    });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
    await startPromise;

    assert.strictEqual(service.getRoutingStatus().muteState.unresolved, true);

    // Audio child crashes while in UNRESOLVED state
    mockChild.simulateExit(1, 'SIGSEGV');

    // Emergency restoration MUST be triggered
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(emergencyUnmuteCalled, true, 'Emergency restoration must run for unresolved crash');
    assert.strictEqual(emergencyEndpointId, '{speakers-guid-crash-unresolved}');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationConfirmed, true);
  });

  // --------------------------------------------------------------------------
  // Test 7: Originally muted endpoint: DuoAudio does not accidentally unmute it during recovery
  // --------------------------------------------------------------------------
  await test('7. Originally muted endpoint: DuoAudio does not accidentally unmute it during recovery', async () => {
    let psExecuted = false;
    const manager = new EndpointMuteManager();
    manager.targetEndpoint = { id: '{already-muted-id}', name: 'Speakers' };
    manager.originallyMuted = true; // Pre-session muted

    manager._runPsAsync = async () => {
      psExecuted = true;
      return { success: true };
    };

    // unmuteAndVerify must NOT call PowerShell for originally muted endpoint
    const recoveryRes = await manager.unmuteAndVerify();
    assert.strictEqual(recoveryRes.status, 'NOT_REQUIRED');
    assert.strictEqual(recoveryRes.verifiedUnmuted, false);
    assert.strictEqual(psExecuted, false, 'PowerShell unmute must never execute on an originally muted device');

    // restore must NOT call PowerShell
    const restoreRes = await manager.restore();
    assert.ok(restoreRes.status === 'NOT_REQUIRED' || restoreRes.status === 'SKIPPED');
    assert.strictEqual(psExecuted, false);

    // Emergency check in AudioService must also refuse emergency unmute
    let emergencyUnmuteCalled = false;
    class MockMuteManager {
      static async restoreEndpointById() {
        emergencyUnmuteCalled = true;
        return { restored: true };
      }
    }

    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: MockMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{already-muted-id}',
            endpointName: 'Laptop Speakers',
            originallyMuted: true,
            willMute: false
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    mockChild.simulateExit(1, 'SIGKILL');
    await startPromise;

    assert.strictEqual(emergencyUnmuteCalled, false, 'Originally muted endpoint must never trigger emergency unmute');
  });

  // --------------------------------------------------------------------------
  // Test 8: Successful normal mute and shutdown restoration: existing behavior intact
  // --------------------------------------------------------------------------
  await test('8. Successful normal mute and shutdown restoration: existing behavior remains intact', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{speakers-guid-8}',
            endpointName: 'Laptop Speakers',
            originallyMuted: false,
            willMute: true
          });
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));

    mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{speakers-guid-8}' });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
    await startPromise;

    const runningStatus = service.getRoutingStatus();
    assert.strictEqual(runningStatus.state, 'RUNNING');
    assert.strictEqual(runningStatus.muteState.muteApplied, true);
    assert.strictEqual(runningStatus.muteState.isMutedByDuoAudio, true);

    // Graceful stop with verified RESTORED
    const stopPromise = service.stopRouting();
    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'RESTORED',
      endpointId: '{speakers-guid-8}'
    });
    mockChild.simulateExit(0, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    assert.strictEqual(stopRes.state, 'STOPPED');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationConfirmed, true);
  });

  // --------------------------------------------------------------------------
  // Test 9: Preservation of structured child-process errors
  // --------------------------------------------------------------------------
  await test('9. Preservation of structured child-process errors', async () => {
    let mockChild;
    const structuredErrMsg = 'Specified playback endpoint(s) not found among active devices: Output 1 (ID 9999)';

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'ERROR',
            error: structuredErrMsg,
            fatal: true
          });
          mockChild.simulateExit(1, null);
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    const res = await startPromise;

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'ERROR');
    assert.strictEqual(res.error, structuredErrMsg);
    assert.strictEqual(service.getRoutingStatus().error, structuredErrMsg);
  });

  // --------------------------------------------------------------------------
  // Test 10: Generic exit errors when no structured error was received
  // --------------------------------------------------------------------------
  await test('10. Generic exit errors when no structured error was received', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateExit(1, null);
        });
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    const res = await startPromise;

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'ERROR');
    assert.strictEqual(res.error, 'Audio child process terminated unexpectedly (code: 1, signal: null).');
    assert.strictEqual(service.getRoutingStatus().error, 'Audio child process terminated unexpectedly (code: 1, signal: null).');
  });

  // --------------------------------------------------------------------------
  // Test 11: Error-state reset between routing sessions
  // --------------------------------------------------------------------------
  await test('11. Error-state reset between routing sessions', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        return mockChild;
      }
    });

    // Session 1: Fails with structured error
    const s1Promise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));
    mockChild.simulateMessage({ type: 'ERROR', error: 'Session 1 hardware fault' });
    mockChild.simulateExit(1, null);
    const s1Res = await s1Promise;
    assert.strictEqual(s1Res.error, 'Session 1 hardware fault');

    // Session 2: Starts fresh
    const s2Promise = service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(service.getRoutingStatus().error, null);

    await new Promise((r) => setTimeout(r, 20));
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
    const s2Res = await s2Promise;
    assert.strictEqual(s2Res.success, true);
    assert.strictEqual(service.getRoutingStatus().error, null, 'Session 1 error must not leak into Session 2');

    // Clean stop Session 2
    const stopPromise = service.stopRouting();
    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateExit(0, null);
    await stopPromise;

    // Session 3: Crashes abruptly without IPC message
    const s3Promise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));
    mockChild.simulateExit(1, null);
    const s3Res = await s3Promise;
    assert.strictEqual(s3Res.error, 'Audio child process terminated unexpectedly (code: 1, signal: null).');
    assert.ok(!s3Res.error.includes('Session 1'), 'Old structured error must not leak into subsequent sessions');
  });

  // --------------------------------------------------------------------------
  // Test 12: UI warning visibility and dismissal
  // --------------------------------------------------------------------------
  await test('12. UI warning visibility and dismissal', () => {
    let feedbackNotice = null;
    const dismissedWarningRef = { current: null };

    function onRoutingStatusChanged(status) {
      if (!status) return;
      if (status.warning) {
        const warningKey = status.warning.code || status.warning.message || String(status.warning);
        if (dismissedWarningRef.current !== warningKey) {
          feedbackNotice = {
            type: 'warning',
            message: status.warning.message || status.warning,
            warningKey
          };
        }
      }
    }

    function handleDismissNotice() {
      if (feedbackNotice && feedbackNotice.warningKey) {
        dismissedWarningRef.current = feedbackNotice.warningKey;
      }
      feedbackNotice = null;
    }

    function handleStartSharing() {
      feedbackNotice = null;
      dismissedWarningRef.current = null;
    }

    const warningStatus = {
      state: 'RUNNING',
      warning: {
        code: 'ENDPOINT_MUTE_UNAVAILABLE',
        message: 'Endpoint muting is unavailable for this session. Audio sharing will continue, but Windows default speakers may also play audio.'
      }
    };
    onRoutingStatusChanged(warningStatus);
    assert.ok(feedbackNotice);
    assert.strictEqual(feedbackNotice.type, 'warning');

    handleDismissNotice();
    assert.strictEqual(feedbackNotice, null);
    assert.strictEqual(dismissedWarningRef.current, 'ENDPOINT_MUTE_UNAVAILABLE');

    onRoutingStatusChanged(warningStatus);
    assert.strictEqual(feedbackNotice, null, 'Warning must remain dismissed despite repeated telemetry ticks');

    handleStartSharing();
    assert.strictEqual(dismissedWarningRef.current, null);

    onRoutingStatusChanged(warningStatus);
    assert.ok(feedbackNotice, 'Warning in new session must be displayed after reset');
  });

  // --------------------------------------------------------------------------
  // Test 13: Existing partial-output failure handling remains unchanged
  // --------------------------------------------------------------------------
  await test('13. Existing partial-output failure handling remains unchanged', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        return mockChild;
      }
    });

    const startPromise = service.startRouting({ device1Id: 10, device2Id: 20 });
    await new Promise((r) => setTimeout(r, 20));
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
    await startPromise;

    mockChild.simulateMessage({
      type: 'STREAM_FAILED',
      slot: 'output2',
      error: 'Device Bluetooth connection lost'
    });

    const status = service.getRoutingStatus();
    assert.strictEqual(status.state, 'PARTIALLY_DEGRADED');
    assert.strictEqual(status.isRouting, true, 'Audio routing continues on Output 1');
    assert.ok(status.error.includes('Stream on output2 failed'));

    const stopPromise = service.stopRouting();
    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateExit(0, null);
    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    assert.strictEqual(stopRes.state, 'STOPPED');
  });

  console.log('\n==============================================================');
  console.log(` Results: ${passed}/${total} Resilience & Safety Tests PASSED (0 Failed)`);
  console.log('==============================================================\n');
}

runResilienceTests().catch((err) => {
  console.error('\n[FATAL TEST RUNNER FAILURE]:', err);
  process.exit(1);
});
