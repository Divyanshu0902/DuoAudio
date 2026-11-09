/**
 * DuoAudio - Phase 5C.2.1: Audio Service Safety, Handshake & Lifecycle Automated Test Suite
 *
 * Verifies:
 * 1. System Node.js executable resolver and runtime validator.
 * 2. Preflight validation (device ID types, identical devices, volumes, stale devices, channel checks).
 * 3. Default output conflict detection.
 * 4. Mute Baseline IPC Handshake (handshake ACK, missing ACK abort, crash-window emergency fallback, state distinctions).
 * 5. Restoration reporting (accurate reporting, FAILED status surfacing, NOT_REQUIRED, SKIPPED, fallback trigger).
 * 6. Process lifecycle guarantees (STOPPED does not resolve stop before exit, stop resolves on exit, injectable timeout fallback,
 *    forced termination awaiting exit, rapid stop/start stale exit guard, duplicate stop sharing).
 * 7. Telemetry, stream failure isolation, and IPC contracts.
 * 8. Real child process integration with genuine system Node.js.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { AudioService, SHUTDOWN_TIMEOUT_MS, FORCED_TERMINATION_TIMEOUT_MS } = require('../src/main/audio-service');
const { resolveSystemNode, validateNodeExecutable } = require('../src/main/node-resolver');
const { IPC_CHANNELS, isValidRoutingStartPayload } = require('../src/shared/ipc-contracts');

// Helper to create a controllable Mock Child Process
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

// Test fixtures
const mockDevices = [
  { id: 10, name: 'realme Buds T310', outputChannels: 2, preferredSampleRate: 48000, isDefault: false },
  { id: 20, name: 'Airdopes 161', outputChannels: 2, preferredSampleRate: 48000, isDefault: false },
  { id: 30, name: 'Laptop Speakers', outputChannels: 2, preferredSampleRate: 48000, isDefault: true },
  { id: 40, name: 'Input Microphone', outputChannels: 0, preferredSampleRate: 44100, isDefault: false }
];

async function runAllTests() {
  console.log('======================================================');
  console.log(' DuoAudio - Phase 5C.2.1 Audio Service Test Suite     ');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  [+] PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [-] FAIL: ${name}`);
      console.error(`      Error: ${err.message}`);
      throw err;
    }
  }

  async function testAsync(name, fn) {
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

  console.log('--- Suite 1: System Node.js Resolver & Validator ---');

  test('Resolves genuine system Node.js successfully', () => {
    const res = resolveSystemNode();
    assert.strictEqual(res.success, true, 'Resolution must succeed');
    assert.ok(res.nodePath, 'Node path must be defined');
    assert.strictEqual(res.arch, 'x64', 'Architecture must be x64');
    assert.strictEqual(res.error, null, 'Error must be null');
  });

  test('Validates that resolved Node executable is genuine and loads native addons', () => {
    const res = resolveSystemNode();
    const val = validateNodeExecutable(res.nodePath);
    assert.strictEqual(val.valid, true, 'Executable must be valid');
    assert.strictEqual(val.arch, 'x64');
    assert.ok(val.version.startsWith('v'), 'Version should start with v');
  });

  test('Rejects invalid or non-existent Node executable path', () => {
    const val = validateNodeExecutable('C:\\non_existent_folder\\fake_node.exe');
    assert.strictEqual(val.valid, false);
    assert.ok(val.error.includes('File not found') || val.error.includes('access error'));
  });

  console.log('\n--- Suite 2: Preflight Validation ---');

  const mockEnumerate = async () => ({ success: true, devices: mockDevices, error: null });

  await testAsync('Rejects non-integer or missing device IDs', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const r1 = await service.validatePreflight({ device1Id: '10', device2Id: 20 });
    assert.strictEqual(r1.valid, false);
    assert.ok(r1.error.includes('valid integer'));

    const r2 = await service.validatePreflight({ device1Id: 10, device2Id: null });
    assert.strictEqual(r2.valid, false);
    assert.ok(r2.error.includes('valid integer'));

    const r3 = await service.validatePreflight({ device1Id: 10.5, device2Id: 20 });
    assert.strictEqual(r3.valid, false);
    assert.ok(r3.error.includes('valid integer'));
  });

  await testAsync('Rejects identical destination output devices', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const r = await service.validatePreflight({ device1Id: 10, device2Id: 10 });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes('same audio device'));
  });

  await testAsync('Rejects invalid volume values', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const r1 = await service.validatePreflight({ device1Id: 10, device2Id: 20, vol1: -0.1 });
    assert.strictEqual(r1.valid, false);
    assert.ok(r1.error.includes('Volume 1'));

    const r2 = await service.validatePreflight({ device1Id: 10, device2Id: 20, vol2: 1.5 });
    assert.strictEqual(r2.valid, false);
    assert.ok(r2.error.includes('Volume 2'));

    const r3 = await service.validatePreflight({ device1Id: 10, device2Id: 20, vol1: NaN });
    assert.strictEqual(r3.valid, false);
    assert.ok(r3.error.includes('Volume 1'));
  });

  await testAsync('Rejects stale/disconnected device ID not in enumeration', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const r = await service.validatePreflight({ device1Id: 999, device2Id: 20 });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes('not currently connected or available'));
  });

  await testAsync('Rejects device with zero output playback channels', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const r = await service.validatePreflight({ device1Id: 10, device2Id: 40 });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.includes('no available output playback channels'));
  });

  await testAsync('Accepts valid configuration and detects default output conflict', async () => {
    const service = new AudioService({ enumerateFn: mockEnumerate });
    const rClean = await service.validatePreflight({ device1Id: 10, device2Id: 20, vol1: 1.0, vol2: 0.8 });
    assert.strictEqual(rClean.valid, true);
    assert.strictEqual(rClean.hasConflict, false);
    assert.strictEqual(rClean.dev1.name, 'realme Buds T310');
    assert.strictEqual(rClean.dev2.name, 'Airdopes 161');

    const rConflict = await service.validatePreflight({ device1Id: 10, device2Id: 30 });
    assert.strictEqual(rConflict.valid, true);
    assert.strictEqual(rConflict.hasConflict, true);
    assert.strictEqual(rConflict.conflictingDev.name, 'Laptop Speakers');
  });

  console.log('\n--- Suite 3: Mute Baseline Handshake & State Protocol ---');

  await testAsync('Main sends MUTE_BASELINE_ACK upon receiving MUTE_BASELINE', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{endpoint-guid-1}',
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

    // Verify ACK was dispatched to child
    assert.strictEqual(mockChild.sentMessages.length, 1);
    assert.strictEqual(mockChild.sentMessages[0].type, 'MUTE_BASELINE_ACK');
    assert.strictEqual(mockChild.sentMessages[0].endpointId, '{endpoint-guid-1}');

    // Verify state: baseline is received, but muteApplied is NOT yet true
    const st = service.getRoutingStatus().muteState;
    assert.strictEqual(st.baselineReceived, true);
    assert.strictEqual(st.muteAttempted, true);
    assert.strictEqual(st.muteApplied, false);
    assert.strictEqual(st.isMutedByDuoAudio, false);

    // Simulate child confirming mute applied
    mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{endpoint-guid-1}' });
    mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });

    await startPromise;
    const stRunning = service.getRoutingStatus().muteState;
    assert.strictEqual(stRunning.muteApplied, true);
    assert.strictEqual(stRunning.isMutedByDuoAudio, true);
  });

  await testAsync('Child crash after baseline but before MUTE_APPLIED triggers safe emergency restoration', async () => {
    let mockChild;
    let emergencyUnmuteCalled = false;
    let unmutedEndpointId = null;

    class MockMuteManager {
      static async restoreEndpointById(id) {
        emergencyUnmuteCalled = true;
        unmutedEndpointId = id;
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
            endpointId: '{speakers-crash-window}',
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

    // Simulate sudden crash BEFORE child could send MUTE_APPLIED (crash window)
    mockChild.simulateExit(1, 'SIGSEGV');

    const result = await startPromise;
    assert.strictEqual(result.success, false);
    assert.strictEqual(emergencyUnmuteCalled, true);
    assert.strictEqual(unmutedEndpointId, '{speakers-crash-window}');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationConfirmed, true);
  });

  await testAsync('Originally muted endpoint is never unmuted even on sudden crash', async () => {
    let mockChild;
    let emergencyUnmuteCalled = false;

    class MockMuteManager {
      static async restoreEndpointById() {
        emergencyUnmuteCalled = true;
        return { restored: true };
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
            endpointId: '{already-muted-endpoint}',
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

    assert.strictEqual(emergencyUnmuteCalled, false, 'Pre-session muted device must never be unmuted');
    assert.strictEqual(service.getRoutingStatus().muteState.originallyMuted, true);
  });

  console.log('\n--- Suite 4: Restoration Reporting & Error Surfacing ---');

  await testAsync('Successful restoration reports RESTORED accurately', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{ep-1}',
            originallyMuted: false,
            willMute: true
          });
          mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{ep-1}' });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    const stopPromise = service.stopRouting();

    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'RESTORED',
      endpointId: '{ep-1}'
    });
    mockChild.simulateExit(0, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    assert.strictEqual(service.state, 'STOPPED');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationStatus, 'RESTORED');
    assert.strictEqual(service.getRoutingStatus().muteState.restorationConfirmed, true);
  });

  await testAsync('Restoration failure in child triggers emergency fallback or surfaces as failure', async () => {
    let mockChild;
    let emergencyCalled = false;

    class MockFailingMuteManager {
      static async restoreEndpointById() {
        emergencyCalled = true;
        return { restored: false, status: 'FAILED', error: 'PowerShell COM error' };
      }
    }

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: MockFailingMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{ep-failing}',
            originallyMuted: false,
            willMute: true
          });
          mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{ep-failing}' });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    const stopPromise = service.stopRouting();

    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'FAILED',
      endpointId: '{ep-failing}',
      error: 'Unmute device failed'
    });
    mockChild.simulateExit(1, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, false);
    assert.strictEqual(service.state, 'ERROR');
    assert.strictEqual(emergencyCalled, true);
    assert.strictEqual(service.getRoutingStatus().muteState.restorationStatus, 'FAILED');
    assert.ok(service.getRoutingStatus().error.includes('PowerShell COM error') || service.getRoutingStatus().error.includes('failed'));
  });

  await testAsync('SKIPPED after DuoAudio muted an originally unmuted endpoint is marked unresolved', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{ep-disc}',
            originallyMuted: false,
            willMute: true
          });
          mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{ep-disc}' });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    const stopPromise = service.stopRouting();

    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'SKIPPED',
      endpointId: '{ep-disc}',
      error: 'Device disconnected'
    });
    mockChild.simulateExit(0, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    const muteState = service.getRoutingStatus().muteState;
    assert.strictEqual(muteState.restorationStatus, 'SKIPPED');
    assert.strictEqual(muteState.restorationConfirmed, false, 'Unmuted endpoint skipped on disconnect must NOT be confirmed');
    assert.strictEqual(muteState.unresolved, true, 'Skipped restoration on unmuted endpoint must be marked unresolved');
    assert.strictEqual(muteState.isMutedByDuoAudio, true, 'Should indicate device was left muted by DuoAudio');
    assert.strictEqual(muteState.endpointId, '{ep-disc}');
    assert.strictEqual(muteState.originallyMuted, false);
  });

  await testAsync('SKIPPED when the endpoint was originally muted is marked safe and confirmed', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{ep-orig-muted}',
            originallyMuted: true,
            willMute: false
          });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    const stopPromise = service.stopRouting();

    mockChild.simulateMessage({ type: 'STOPPED' });
    mockChild.simulateMessage({
      type: 'MUTE_RESTORATION_RESULT',
      status: 'SKIPPED',
      endpointId: '{ep-orig-muted}',
      error: 'Device disconnected'
    });
    mockChild.simulateExit(0, null);

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, true);
    const muteState = service.getRoutingStatus().muteState;
    assert.strictEqual(muteState.restorationStatus, 'SKIPPED');
    assert.strictEqual(muteState.restorationConfirmed, true, 'Originally muted endpoint is safe when skipped');
    assert.strictEqual(muteState.unresolved, false, 'Originally muted endpoint must not be marked unresolved');
    assert.strictEqual(muteState.isMutedByDuoAudio, false);
    assert.strictEqual(muteState.originallyMuted, true);
  });

  await testAsync('Emergency restoration returning SKIPPED preserves unresolved status without overwriting to RESTORED', async () => {
    let mockChild;
    let emergencyUnmuteCalled = false;

    class MockSkippingMuteManager {
      static async restoreEndpointById(id) {
        emergencyUnmuteCalled = true;
        return { restored: false, status: 'SKIPPED', reason: 'Endpoint disconnected' };
      }
    }

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      muteManagerClass: MockSkippingMuteManager,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({
            type: 'MUTE_BASELINE',
            endpointId: '{ep-emergency-skipped}',
            originallyMuted: false,
            willMute: true
          });
          mockChild.simulateMessage({ type: 'MUTE_APPLIED', endpointId: '{ep-emergency-skipped}' });
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    // Child crashes suddenly without clean restoration
    mockChild.simulateExit(1, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(emergencyUnmuteCalled, true);
    const muteState = service.getRoutingStatus().muteState;
    assert.strictEqual(muteState.restorationStatus, 'SKIPPED', 'Must NOT be overwritten to RESTORED');
    assert.strictEqual(muteState.restorationConfirmed, false);
    assert.strictEqual(muteState.unresolved, true);
    assert.strictEqual(muteState.isMutedByDuoAudio, true);
    assert.strictEqual(muteState.endpointId, '{ep-emergency-skipped}');
    assert.strictEqual(muteState.originallyMuted, false);
  });

  console.log('\n--- Suite 5: Process Lifecycle & Race Condition Guards ---');

  await testAsync('STOPPED does NOT resolve stopRouting before actual process exit', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    let isResolved = false;
    const stopPromise = service.stopRouting().then((res) => {
      isResolved = true;
      return res;
    });

    assert.strictEqual(service.state, 'STOPPING');

    // Simulate child sending STOPPED
    mockChild.simulateMessage({ type: 'STOPPED' });
    await new Promise((r) => setTimeout(r, 20));

    // STRICT ASSERTION: Must NOT be resolved merely on STOPPED message!
    assert.strictEqual(isResolved, false, 'stopRouting must not resolve before actual process exit');

    // Now emit exit
    mockChild.simulateExit(0, null);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(isResolved, true, 'stopRouting must resolve after process exit');
    const res = await stopPromise;
    assert.strictEqual(res.success, true);
    assert.strictEqual(service.state, 'STOPPED');
  });

  await testAsync('child.killed === true while exitCode and signalCode are still null does NOT resolve stopRouting prematurely', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    // Simulate child.killed being set to true externally (e.g. signal dispatched) while process is still alive in OS
    mockChild.killed = true;
    mockChild.exitCode = null;
    mockChild.signalCode = null;

    let isResolved = false;
    const stopPromise = service.stopRouting().then((res) => {
      isResolved = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 20));

    // STRICT ASSERTION: child.killed === true must NOT cause premature resolution!
    assert.strictEqual(isResolved, false, 'stopRouting must not resolve while exitCode and signalCode are null');

    // Now emit exit
    mockChild.simulateExit(0, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(isResolved, true);
    const res = await stopPromise;
    assert.strictEqual(res.success, true);
    assert.strictEqual(service.state, 'STOPPED');
  });

  await testAsync('Real shutdown timeout callback is exercised by short injectable timeout', async () => {
    let mockChild;

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      shutdownTimeoutMs: 40,
      forcedTerminationTimeoutMs: 300,
      spawnFn: () => {
        mockChild = new MockChildProcess();
        mockChild.send = () => {}; // Ignore SHUTDOWN to simulate hung process
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    let isResolved = false;
    const stopPromise = service.stopRouting().then((res) => {
      isResolved = true;
      return res;
    });

    // Wait for the 40ms timeout to fire naturally
    await new Promise((r) => setTimeout(r, 60));

    // Still waiting for process exit (hard timeout is 300ms)!
    assert.strictEqual(isResolved, false, 'Forced termination must still wait for process exit');

    // Emit exit after forced kill
    mockChild.simulateExit(0, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(isResolved, true);
    const res = await stopPromise;
    assert.strictEqual(res.success, true);
  });

  await testAsync('Forced termination secondary timeout resolves stop with error, retains child reference, and rejects subsequent starts', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      shutdownTimeoutMs: 30, // 30ms graceful timeout
      forcedTerminationTimeoutMs: 30, // 30ms hard timeout
      spawnFn: () => {
        mockChild = new MockChildProcess(9988);
        mockChild.send = () => {}; // Ignore SHUTDOWN
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(service.state, 'RUNNING');

    // Initiate stop; mockChild never exits (simulates kernel deadlock)
    const stopPromise = service.stopRouting();

    // Wait for graceful (30ms) + hard (30ms) = 60ms timeout to expire
    await new Promise((r) => setTimeout(r, 90));

    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.success, false);
    assert.strictEqual(stopRes.state, 'ERROR');
    assert.ok(stopRes.error.includes('deadline after forced termination'));
    assert.strictEqual(service.state, 'ERROR');

    // CRITICAL: Child reference MUST be retained to prevent new starts!
    assert.strictEqual(service._child, mockChild, 'Child process reference must be retained on hard timeout');

    // New start must be rejected!
    const startRes = await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(startRes.success, false);
    assert.ok(startRes.error.includes('already active or a previous session is still terminating'));

    // Old child eventually exits after timeout and service state is reconciled
    mockChild.simulateExit(0, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(service._child, null, 'Child reference must be cleared once exit event finally arrives');
    assert.strictEqual(service.state, 'STOPPED', 'Service state must be reconciled to STOPPED');
  });

  await testAsync('Rapid stop/start does not allow an old child exit handler to affect a new session', async () => {
    let child1;
    let child2;
    let spawnCount = 0;

    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        spawnCount++;
        if (spawnCount === 1) {
          child1 = new MockChildProcess(1001);
          process.nextTick(() => {
            child1.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
          });
          return child1;
        } else {
          child2 = new MockChildProcess(1002);
          process.nextTick(() => {
            child2.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
          });
          return child2;
        }
      }
    });

    // Start session 1
    await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(service.state, 'RUNNING');

    // Stop session 1
    const stopPromise = service.stopRouting();
    child1.simulateExit(0, null);
    await stopPromise;
    assert.strictEqual(service.state, 'STOPPED');

    // Start session 2
    await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(service.state, 'RUNNING');
    assert.strictEqual(service._child, child2);

    // Stale late exit event from child 1 fires:
    child1.simulateExit(1, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 20));

    // STRICT GUARANTEE: Session 2 is unaffected!
    assert.strictEqual(service.state, 'RUNNING', 'New session state must not be corrupted by stale child exit');
    assert.strictEqual(service._child, child2, 'Active child reference must not be nulled by stale child exit');

    // Stop session 2 cleanly
    const stop2 = service.stopRouting();
    child2.simulateExit(0, null);
    await stop2;
  });

  await testAsync('Repeated stop requests are safe and share the same in-flight operation', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    const p1 = service.stopRouting();
    const p2 = service.stopRouting();
    assert.strictEqual(p1, p2, 'Repeated stop calls must return the same stop promise');

    mockChild.simulateExit(0, null);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
  });

  await testAsync('New session is rejected if an old child cannot be confirmed terminated', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    // Stop requested, but child has NOT exited yet
    service.stopRouting();
    assert.strictEqual(service.state, 'STOPPING');

    // Attempt to start a new session while child is still alive
    const rejectRes = await service.startRouting({ device1Id: 10, device2Id: 20 });
    assert.strictEqual(rejectRes.success, false);
    assert.ok(rejectRes.error.includes('terminating') || rejectRes.error.includes('active'));

    mockChild.simulateExit(0, null);
  });

  console.log('\n--- Suite 6: Telemetry, Isolation, and IPC Contract ---');

  await testAsync('Updates latest metrics and handles stream failure isolation', async () => {
    let mockChild;
    const service = new AudioService({
      enumerateFn: mockEnumerate,
      nodePath: 'C:\\node.exe',
      spawnFn: () => {
        mockChild = new MockChildProcess();
        process.nextTick(() => {
          mockChild.simulateMessage({ type: 'STATE_CHANGE', state: 'RUNNING' });
        });
        return mockChild;
      }
    });

    await service.startRouting({ device1Id: 10, device2Id: 20 });

    mockChild.simulateMessage({
      type: 'METRICS',
      timestamp: 1700000000,
      capture: { active: true, rmsDb: -14.2, peakDb: -3.1 },
      output1: { state: 'RUNNING', bufferHealthMs: 80, underruns: 0, drops: 0 },
      output2: { state: 'RUNNING', bufferHealthMs: 80, underruns: 0, drops: 0 }
    });

    const statusWithMetrics = service.getRoutingStatus();
    assert.ok(statusWithMetrics.metrics);
    assert.strictEqual(statusWithMetrics.metrics.capture.rmsDb, -14.2);

    mockChild.simulateMessage({
      type: 'STREAM_FAILED',
      slot: 'output2',
      error: 'Device unplugged'
    });

    assert.strictEqual(service.state, 'PARTIALLY_DEGRADED');
    assert.ok(service.getRoutingStatus().error.includes('output2'));

    const stopP = service.stopRouting();
    mockChild.simulateExit(0, null);
    await stopP;
  });

  test('Malformed IPC messages from child are safely ignored without throwing', () => {
    const service = new AudioService();
    service._handleChildIpcMessage(null, null);
    service._handleChildIpcMessage(null, undefined);
    service._handleChildIpcMessage(null, 'invalid string');
    service._handleChildIpcMessage(null, { unexpected: true });
    service._handleChildIpcMessage(null, { type: 'UNKNOWN_TYPE' });
    assert.strictEqual(service.state, 'IDLE');
  });

  test('IPC Contracts and payload validation functions', () => {
    assert.ok(IPC_CHANNELS.ROUTING_START);
    assert.ok(IPC_CHANNELS.ROUTING_STOP);
    assert.ok(IPC_CHANNELS.ROUTING_GET_STATUS);
    assert.ok(IPC_CHANNELS.ROUTING_STATUS_CHANGED);

    assert.strictEqual(isValidRoutingStartPayload({ device1Id: 1, device2Id: 2 }), true);
    assert.strictEqual(isValidRoutingStartPayload({ device1Id: 1, device2Id: 2, vol1: 0.5, vol2: 1.0 }), true);
    assert.strictEqual(isValidRoutingStartPayload({ device1Id: 1, device2Id: 1 }), false); // Duplicate
    assert.strictEqual(isValidRoutingStartPayload({ device1Id: '1', device2Id: 2 }), false); // String ID
    assert.strictEqual(isValidRoutingStartPayload({ device1Id: 1, device2Id: 2, vol1: 1.5 }), false); // Out of range
    assert.strictEqual(isValidRoutingStartPayload(null), false);
  });

  console.log('\n--- Suite 7: Real Child Process IPC Integration ---');

  const { spawn: realSpawn } = require('child_process');
  const path = require('path');
  const runnerScript = path.resolve(__dirname, '../src/audio_runner.js');
  const resolvedNode = resolveSystemNode().nodePath;

  await testAsync('Real audio_runner.js responds to IPC SHUTDOWN and exits cleanly with MUTE_RESTORATION_RESULT', async () => {
    const child = realSpawn(resolvedNode, [runnerScript], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const messages = [];
    child.on('message', (m) => messages.push(m));

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    await new Promise((r) => setTimeout(r, 150));
    child.send({ type: 'SHUTDOWN' });

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 0);
    assert.ok(messages.some((m) => m.type === 'STOPPED'), 'Must emit STOPPED');
    assert.ok(messages.some((m) => m.type === 'MUTE_RESTORATION_RESULT'), 'Must emit MUTE_RESTORATION_RESULT');
  });

  await testAsync('Real audio_runner.js reports structured error on missing device', async () => {
    const child = realSpawn(resolvedNode, [runnerScript], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const messages = [];
    child.on('message', (m) => messages.push(m));

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    child.send({ type: 'START', device1Id: 99999, device2Id: 99998 });

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 1);
    const err = messages.find((m) => m.type === 'ERROR');
    assert.ok(err);
    assert.ok(err.error.includes('Specified playback endpoint(s) not found'));
  });

  await testAsync('Real audio_runner.js cleanly terminates upon parent IPC disconnect', async () => {
    const child = realSpawn(resolvedNode, [runnerScript], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    await new Promise((r) => setTimeout(r, 150));
    child.disconnect();

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 0);
  });

  console.log('\n======================================================');
  console.log(` Results: ${passed}/${total} Tests PASSED (0 Failed)`);
  console.log('======================================================\n');
}

runAllTests().catch((err) => {
  console.error('\n[FATAL TEST RUNNER FAILURE]:', err);
  process.exit(1);
});
