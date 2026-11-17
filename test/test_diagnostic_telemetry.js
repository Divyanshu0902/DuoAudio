/**
 * DuoAudio - Phase 8.1 Diagnostic Telemetry Test Suite
 *
 * Verifies the observational diagnostic telemetry implementation:
 * 1. CircularBuffer capacity, FIFO ordering, rollover, and percentiles.
 * 2. DistributionTracker mathematical accuracy and histogram bucketing.
 * 3. CaptureTelemetry interval, byte, and frame tracking.
 * 4. OutputStreamTelemetry write duration, pacer interval, and queue depth metrics.
 * 5. Complete per-output metric isolation (Output 1 vs Output 2).
 * 6. AudioBuffer queue depth min/max/average tracking and drop-oldest retention.
 * 7. Snapshot generation and AudioService IPC integration.
 * 8. Clean behavior when telemetry is disabled or unavailable.
 * 9. Audio behavior invariance verification.
 */

const assert = require('assert');
const {
  CircularBuffer,
  DistributionTracker,
  CaptureTelemetry,
  OutputStreamTelemetry,
  createTelemetrySnapshot
} = require('../src/telemetry');
const { AudioBuffer } = require('../src/audio_buffer');
const { OutputStream, FRAME_SIZE, SAMPLE_RATE, CHANNELS, EXPECTED_BUFFER_BYTES } = require('../src/output_stream');
const { AudioService } = require('../src/main/audio-service');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [+] PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [-] FAIL: ${name}`);
    console.error(`      Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

async function runTestAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [+] PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [-] FAIL: ${name}`);
    console.error(`      Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

console.log('===============================================================');
console.log(' DuoAudio - Phase 8.1 Diagnostic Telemetry Test Suite');
console.log('===============================================================\n');

// --- Suite 1: CircularBuffer & Rollover ---
console.log('--- Suite 1: CircularBuffer Capacity & Rollover ---');

runTest('1. CircularBuffer retains chronological order within capacity', () => {
  const cb = new CircularBuffer(16);
  for (let i = 1; i <= 10; i++) {
    cb.push(i);
  }
  assert.strictEqual(cb.size, 10);
  assert.strictEqual(cb.totalPushed, 10);
  assert.deepStrictEqual(cb.toArray(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

runTest('2. CircularBuffer rolls over when capacity exceeded without memory growth', () => {
  const capacity = 16;
  const cb = new CircularBuffer(capacity);
  // Push 25 items into capacity of 16
  for (let i = 1; i <= 25; i++) {
    cb.push(i);
  }
  assert.strictEqual(cb.size, capacity, 'Buffer size should be clamped to capacity');
  assert.strictEqual(cb.totalPushed, 25, 'Total pushed count should reflect all 25 items');
  assert.strictEqual(cb.isFull(), true);

  // Expected items: 10 through 25 (last 16 items)
  const expected = [];
  for (let i = 10; i <= 25; i++) expected.push(i);
  assert.deepStrictEqual(cb.toArray(), expected);
});

runTest('3. CircularBuffer calculates percentiles accurately', () => {
  const cb = new CircularBuffer(100);
  // Push numbers 1 to 100
  for (let i = 1; i <= 100; i++) {
    cb.push(i);
  }
  assert.strictEqual(cb.getPercentile(50), 51);
  assert.strictEqual(cb.getPercentile(95), 95);
  assert.strictEqual(cb.getPercentile(99), 99);
});

runTest('4. CircularBuffer clears cleanly', () => {
  const cb = new CircularBuffer(16);
  cb.push(42);
  cb.push(99);
  cb.clear();
  assert.strictEqual(cb.size, 0);
  assert.strictEqual(cb.totalPushed, 0);
  assert.deepStrictEqual(cb.toArray(), []);
});

// --- Suite 2: DistributionTracker & Mathematical Accuracy ---
console.log('\n--- Suite 2: DistributionTracker Aggregations & Bucketing ---');

runTest('5. DistributionTracker aggregates count, min, max, sum, and average', () => {
  const tracker = new DistributionTracker({
    name: 'testInterval',
    unit: 'ms',
    bucketThresholds: [8, 12, 16],
    bucketLabels: ['<8ms', '8-12ms', '12-16ms', '>16ms']
  });

  tracker.record(10.0);
  tracker.record(5.0);
  tracker.record(15.0);
  tracker.record(20.0);

  const snap = tracker.getSnapshot();
  assert.strictEqual(snap.count, 4);
  assert.strictEqual(snap.min, 5.0);
  assert.strictEqual(snap.max, 20.0);
  assert.strictEqual(snap.avg, 12.5);
  assert.strictEqual(snap.distribution['<8ms'], 1);
  assert.strictEqual(snap.distribution['8-12ms'], 1);
  assert.strictEqual(snap.distribution['12-16ms'], 1);
  assert.strictEqual(snap.distribution['>16ms'], 1);
});

runTest('6. DistributionTracker safely ignores invalid/NaN values', () => {
  const tracker = new DistributionTracker({ name: 'safeTracker' });
  tracker.record(NaN);
  tracker.record('invalid');
  tracker.record(null);
  tracker.record(undefined);
  assert.strictEqual(tracker.count, 0);
  assert.strictEqual(tracker.average, 0);
});

// --- Suite 3: CaptureTelemetry ---
console.log('\n--- Suite 3: CaptureTelemetry Ingestion & Metrics ---');

runTest('7. CaptureTelemetry tracks callbacks, bytes, and frames', () => {
  const cap = new CaptureTelemetry({ enabled: true });

  // 1920 bytes S16 stereo = 480 stereo frames
  cap.recordCallback(1920);
  cap.recordCallback(1920);
  cap.recordPcmFrames(2); // 2 output 20 ms frames

  const snap = cap.getSnapshot();
  assert.strictEqual(snap.enabled, true);
  assert.strictEqual(snap.capturedBytes, 3840);
  assert.strictEqual(snap.capturedFrames, 960);
  assert.strictEqual(snap.pcmOutputFrames, 2);
  assert.strictEqual(snap.callbackIntervalMs.count, 1, 'Two callbacks yield one interval');
});

runTest('8. CaptureTelemetry respects disabled mode without throwing', () => {
  const cap = new CaptureTelemetry({ enabled: false });
  cap.recordCallback(1920);
  cap.recordPcmFrames(5);
  const snap = cap.getSnapshot();
  assert.strictEqual(snap.enabled, false);
  assert.strictEqual(snap.capturedBytes, undefined);
});

// --- Suite 4: OutputStreamTelemetry & Metric Isolation ---
console.log('\n--- Suite 4: OutputStreamTelemetry & Per-Output Isolation ---');

runTest('9. OutputStreamTelemetry records write duration, pacer ticks, and queue depths', () => {
  const ost = new OutputStreamTelemetry({ name: 'Output 1', enabled: true });

  ost.recordPacerTick();
  ost.recordWriteDuration(125.5);
  ost.recordWriteDuration(80.0);
  ost.recordSubmittedFrames(2);
  ost.recordEmptyQueueTick();
  ost.recordQueueDepth(4);
  ost.recordQueueDepth(5);

  const snap = ost.getSnapshot({ queuedBuffers: 4, queuedMs: 80, droppedBuffers: 0 });
  assert.strictEqual(snap.name, 'Output 1');
  assert.strictEqual(snap.submittedFrames, 2);
  assert.strictEqual(snap.emptyQueuePacerTicks, 1);
  assert.strictEqual(snap.writeDurationUs.count, 2);
  assert.strictEqual(snap.writeDurationUs.min, 80.0);
  assert.strictEqual(snap.writeDurationUs.max, 125.5);
  assert.strictEqual(snap.queueDepth.currentFrames, 4);
  assert.strictEqual(snap.queueDepth.minFrames, 4);
  assert.strictEqual(snap.queueDepth.maxFrames, 5);
});

runTest('10. Output 1 and Output 2 telemetry remain completely isolated', () => {
  const ost1 = new OutputStreamTelemetry({ name: 'Output 1', enabled: true });
  const ost2 = new OutputStreamTelemetry({ name: 'Output 2', enabled: true });

  // Stream 1: simulate rapid consumption and 3 empty ticks
  ost1.recordSubmittedFrames(10);
  ost1.recordEmptyQueueTick();
  ost1.recordEmptyQueueTick();
  ost1.recordEmptyQueueTick();
  ost1.recordWriteDuration(50);

  // Stream 2: simulate slow consumption, 0 empty ticks, higher write duration
  ost2.recordSubmittedFrames(5);
  ost2.recordWriteDuration(350);

  const snap1 = ost1.getSnapshot();
  const snap2 = ost2.getSnapshot();

  assert.strictEqual(snap1.submittedFrames, 10);
  assert.strictEqual(snap1.emptyQueuePacerTicks, 3);
  assert.strictEqual(snap1.writeDurationUs.avg, 50);

  assert.strictEqual(snap2.submittedFrames, 5);
  assert.strictEqual(snap2.emptyQueuePacerTicks, 0, 'Stream 2 must not inherit Stream 1 empty ticks');
  assert.strictEqual(snap2.writeDurationUs.avg, 350, 'Stream 2 write duration must remain independent');
});

runTest('11. OutputStreamTelemetry handles disabled mode gracefully', () => {
  const ost = new OutputStreamTelemetry({ name: 'DisabledStream', enabled: false });
  ost.recordPacerTick();
  ost.recordWriteDuration(100);
  ost.recordSubmittedFrames(5);
  ost.recordEmptyQueueTick();
  const snap = ost.getSnapshot();
  assert.strictEqual(snap.enabled, false);
  assert.strictEqual(snap.submittedFrames, undefined);
});

// --- Suite 5: AudioBuffer Queue Depth Tracking & Bounded Capacity ---
console.log('\n--- Suite 5: AudioBuffer Queue Depth Tracking ---');

runTest('12. AudioBuffer tracks min, max, and avg queue depth across push/pop', () => {
  const buf = new AudioBuffer({ frameDurationMs: 20, maxCapacityMs: 200, targetPrebufferMs: 80 });

  // Push 4 frames (80 ms)
  const dummy = Buffer.alloc(7680);
  buf.push(dummy);
  buf.push(dummy);
  buf.push(dummy);
  buf.push(dummy);

  let stats = buf.getStats();
  assert.strictEqual(stats.queuedBuffers, 4);
  assert.strictEqual(stats.queuedMs, 80);
  assert.strictEqual(stats.minQueueBuffers, 1);
  assert.strictEqual(stats.maxQueueBuffers, 4);
  assert.strictEqual(stats.maxQueueMs, 80);

  // Pop 2 frames (queue goes from 4 -> 3 -> 2)
  buf.pop();
  buf.pop();

  stats = buf.getStats();
  assert.strictEqual(stats.queuedBuffers, 2);
  assert.strictEqual(stats.queuedMs, 40);
  assert.strictEqual(stats.minQueueBuffers, 1);
  assert.strictEqual(stats.maxQueueBuffers, 4);
  assert.ok(stats.avgQueueBuffers >= 1.0 && stats.avgQueueBuffers <= 4.0);

  // Pop remaining 2 frames (queue goes from 2 -> 1 -> 0)
  buf.pop();
  buf.pop();
  stats = buf.getStats();
  assert.strictEqual(stats.queuedBuffers, 0);
  assert.strictEqual(stats.minQueueBuffers, 0);
});

runTest('13. AudioBuffer preserves exact 200 ms capacity and drop-oldest overflow policy', () => {
  const buf = new AudioBuffer({ frameDurationMs: 20, maxCapacityMs: 200, targetPrebufferMs: 80 });
  const dummy1 = Buffer.from([1, 1, 1]);
  const dummy2 = Buffer.from([2, 2, 2]);

  buf.push(dummy1); // oldest
  for (let i = 0; i < 9; i++) {
    buf.push(Buffer.from([0, 0, 0]));
  }
  assert.strictEqual(buf.length, 10, 'Queue should reach 10 frames (200 ms)');

  // 11th push: triggers drop-oldest
  const pushedWithoutDrop = buf.push(dummy2);
  assert.strictEqual(pushedWithoutDrop, false, 'Must indicate frame was dropped');
  assert.strictEqual(buf.length, 10, 'Queue depth must remain capped at 10');
  assert.strictEqual(buf.droppedBuffers, 1);
  assert.strictEqual(buf.overflowCount, 1);

  // Verify oldest was dropped
  const oldestRemaining = buf.pop();
  assert.notStrictEqual(oldestRemaining, dummy1, 'Oldest frame dummy1 must have been discarded');
});

// --- Suite 6: Snapshot Generation & AudioService IPC Integration ---
console.log('\n--- Suite 6: Snapshot Generation & AudioService IPC Integration ---');

runTest('14. createTelemetrySnapshot combines capture and dual streams cleanly', () => {
  const cap = new CaptureTelemetry();
  cap.recordCallback(3840);
  cap.recordPcmFrames(1);

  const ost1 = new OutputStreamTelemetry({ name: 'Output 1' });
  ost1.recordSubmittedFrames(4);

  const ost2 = new OutputStreamTelemetry({ name: 'Output 2' });
  ost2.recordSubmittedFrames(2);

  const snapshot = createTelemetrySnapshot({
    capture: cap,
    stream1: ost1,
    stream2: ost2,
    stream1BufferStats: { queuedBuffers: 2, queuedMs: 40, droppedBuffers: 0 },
    stream2BufferStats: { queuedBuffers: 1, queuedMs: 20, droppedBuffers: 0 }
  });

  assert.ok(snapshot.timestamp > 0);
  assert.strictEqual(snapshot.capture.pcmOutputFrames, 1);
  assert.strictEqual(snapshot.output1.submittedFrames, 4);
  assert.strictEqual(snapshot.output2.submittedFrames, 2);
  assert.ok(snapshot.output1.semantics.emptyQueuePacerTicks.includes('observational'));
});

runTest('15. AudioService stores and exposes latest telemetry snapshot', () => {
  const service = new AudioService({
    nodePath: 'C:\\fake\\node.exe',
    enumerateFn: async () => ({ success: true, devices: [] })
  });

  assert.strictEqual(service.getTelemetrySnapshot(), null);
  assert.strictEqual(service.getRoutingStatus().telemetry, null);

  // Simulate incoming TELEMETRY_SNAPSHOT IPC message from audio runner child
  const mockSnapshot = {
    timestamp: Date.now(),
    capture: { pcmOutputFrames: 100 },
    output1: { queueDepth: { currentMs: 80 }, submittedFrames: 50 },
    output2: { queueDepth: { currentMs: 60 }, submittedFrames: 48 }
  };

  service._handleChildIpcMessage(null, {
    type: 'TELEMETRY_SNAPSHOT',
    data: mockSnapshot
  });

  assert.deepStrictEqual(service.getTelemetrySnapshot(), mockSnapshot);
  assert.deepStrictEqual(service.getRoutingStatus().telemetry, mockSnapshot);
});

// --- Suite 7: Audio Invariance & Parameter Verification ---
console.log('\n--- Suite 7: Audio Invariance & Behavior Preservation ---');

runTest('16. Audio pipeline constants and parameter invariance preserved', () => {
  assert.strictEqual(FRAME_SIZE, 960, 'Frame size must remain exactly 960 (20 ms at 48 kHz)');
  assert.strictEqual(SAMPLE_RATE, 48000, 'Sample rate must remain 48,000 Hz');
  assert.strictEqual(CHANNELS, 2, 'Channel count must remain stereo (2)');
  assert.strictEqual(EXPECTED_BUFFER_BYTES, 7680, 'Expected buffer bytes must remain 7,680 (Float32)');
});

runTest('17. OutputStream supports telemetry: false without behavioral alteration', () => {
  const stream = new OutputStream({
    name: 'NoTelemetryStream',
    telemetry: false
  });
  assert.strictEqual(stream.telemetry, null);
  const diag = stream.getDiagnostics();
  assert.strictEqual(diag.telemetry, null);
  assert.strictEqual(diag.name, 'NoTelemetryStream');
  assert.strictEqual(diag.volumePercent, 100);
});

console.log('\n===============================================================');
console.log(` Results: ${passedTests}/${totalTests} tests passed`);
console.log('===============================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
