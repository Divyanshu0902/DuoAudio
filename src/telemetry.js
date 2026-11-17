/**
 * DuoAudio - Phase 8.1: Diagnostic Telemetry Subsystem
 *
 * Provides high-resolution, low-overhead diagnostic telemetry for the DuoAudio
 * audio pipeline. Measures timing distributions, queue depths, write execution
 * durations, and capture callback regularity using process.hrtime.bigint() and
 * fixed-capacity in-memory buffers.
 *
 * Strict Architectural Guarantees:
 * 1. Observational only: Zero mutations to audio data, routing, pacing, or buffering.
 * 2. Zero-allocation fast paths: Uses fixed-capacity typed arrays and pre-allocated
 *    circular buffers to eliminate GC pauses inside audio callbacks.
 * 3. Complete per-output isolation: Output 1 and Output 2 metrics are tracked in
 *    completely independent telemetry instances.
 * 4. Transparent definitions: Accurately distinguishes measured values from estimates
 *    (e.g. empty-queue pacer ticks vs hardware underruns).
 */

/**
 * Fixed-capacity circular buffer backed by a Float64Array.
 * Stores recent scalar measurements without dynamic memory allocations.
 */
class CircularBuffer {
  /**
   * @param {number} [capacity=128] - Maximum number of entries to retain.
   */
  constructor(capacity = 128) {
    this.capacity = Math.max(16, capacity);
    this.buffer = new Float64Array(this.capacity);
    this.head = 0;
    this.size = 0;
    this.totalPushed = 0;
  }

  /**
   * Pushes a new numeric value into the circular buffer.
   * Overwrites the oldest entry when capacity is reached.
   *
   * @param {number} value
   */
  push(value) {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
    this.totalPushed++;
  }

  /**
   * Returns whether the buffer has filled its capacity at least once.
   * @returns {boolean}
   */
  isFull() {
    return this.size >= this.capacity;
  }

  /**
   * Returns all currently stored values in chronological order (oldest to newest).
   * @returns {number[]}
   */
  toArray() {
    const result = new Array(this.size);
    if (this.size === 0) return result;

    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      result[i] = this.buffer[(start + i) % this.capacity];
    }
    return result;
  }

  /**
   * Computes a percentile (0 to 100) from the currently buffered values.
   *
   * @param {number} p - Percentile between 0 and 100 (e.g. 50, 95, 99)
   * @returns {number}
   */
  getPercentile(p) {
    if (this.size === 0) return 0;
    const sorted = this.toArray().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index];
  }

  /**
   * Clears all values.
   */
  clear() {
    this.head = 0;
    this.size = 0;
    this.totalPushed = 0;
    this.buffer.fill(0);
  }
}

/**
 * Tracks scalar distribution metrics: count, min, max, average,
 * fixed histogram buckets, and percentiles over a rolling circular buffer.
 */
class DistributionTracker {
  /**
   * @param {Object} options
   * @param {string} options.name - Descriptive name of the metric
   * @param {string} options.unit - Unit of measurement (e.g. 'ms', 'us')
   * @param {number[]} [options.bucketThresholds] - Ascending upper bounds for histogram buckets
   * @param {string[]} [options.bucketLabels] - Labels for histogram buckets
   * @param {number} [options.historyCapacity=128] - Rolling circular buffer capacity
   */
  constructor(options = {}) {
    this.name = options.name || 'metric';
    this.unit = options.unit || '';
    this.bucketThresholds = Array.isArray(options.bucketThresholds) ? options.bucketThresholds : [];
    this.bucketLabels = Array.isArray(options.bucketLabels) ? options.bucketLabels : [];

    // Pre-allocate bucket counters
    this.bucketCounts = new Int32Array(this.bucketThresholds.length + 1);

    // Rolling recent history for percentiles
    this.history = new CircularBuffer(options.historyCapacity || 128);

    // Lifetime running aggregates
    this.count = 0;
    this.sum = 0.0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  /**
   * Records a single numeric observation.
   * Fast-path: O(1) time complexity, zero memory allocation.
   *
   * @param {number} value
   */
  record(value) {
    if (typeof value !== 'number' || isNaN(value)) return;

    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;

    // Fast bucket classification
    let classified = false;
    for (let i = 0; i < this.bucketThresholds.length; i++) {
      if (value < this.bucketThresholds[i]) {
        this.bucketCounts[i]++;
        classified = true;
        break;
      }
    }
    if (!classified) {
      this.bucketCounts[this.bucketThresholds.length]++;
    }

    this.history.push(value);
  }

  /**
   * Returns the running average of all recorded observations.
   * @returns {number}
   */
  get average() {
    return this.count > 0 ? this.sum / this.count : 0;
  }

  /**
   * Returns a complete distribution snapshot.
   * @returns {Object}
   */
  getSnapshot() {
    const distribution = {};
    for (let i = 0; i < this.bucketLabels.length; i++) {
      distribution[this.bucketLabels[i]] = this.bucketCounts[i];
    }

    return {
      name: this.name,
      unit: this.unit,
      count: this.count,
      min: this.count > 0 ? Number(this.min.toFixed(3)) : 0,
      max: this.count > 0 ? Number(this.max.toFixed(3)) : 0,
      avg: this.count > 0 ? Number(this.average.toFixed(3)) : 0,
      p50: this.count > 0 ? Number(this.history.getPercentile(50).toFixed(3)) : 0,
      p95: this.count > 0 ? Number(this.history.getPercentile(95).toFixed(3)) : 0,
      p99: this.count > 0 ? Number(this.history.getPercentile(99).toFixed(3)) : 0,
      distribution
    };
  }

  /**
   * Resets all metrics.
   */
  reset() {
    this.count = 0;
    this.sum = 0.0;
    this.min = Infinity;
    this.max = -Infinity;
    this.bucketCounts.fill(0);
    this.history.clear();
  }
}

/**
 * Diagnostic telemetry for WASAPI Loopback Capture and PCM Conversion.
 */
class CaptureTelemetry {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    // Capture callback interval tracker (target ~10 ms, varies by WASAPI quantum)
    this.callbackInterval = new DistributionTracker({
      name: 'captureCallbackInterval',
      unit: 'ms',
      bucketThresholds: [5.0, 10.0, 15.0, 20.0, 25.0],
      bucketLabels: ['<5ms', '5-10ms', '10-15ms', '15-20ms', '20-25ms', '>25ms'],
      historyCapacity: 128
    });

    this.capturedBytes = 0;
    this.capturedFrames = 0;
    this.pcmOutputFrames = 0;
    this.lastCallbackHr = 0n;
  }

  /**
   * Records a capture callback arrival.
   *
   * @param {number} byteLength - Number of bytes received in the chunk
   */
  recordCallback(byteLength) {
    if (!this.enabled) return;

    const nowHr = process.hrtime.bigint();
    if (this.lastCallbackHr !== 0n) {
      const deltaNs = Number(nowHr - this.lastCallbackHr);
      const deltaMs = deltaNs / 1e6;
      this.callbackInterval.record(deltaMs);
    }
    this.lastCallbackHr = nowHr;

    if (typeof byteLength === 'number' && byteLength > 0) {
      this.capturedBytes += byteLength;
      // 16-bit stereo PCM = 4 bytes per stereo frame
      this.capturedFrames += Math.floor(byteLength / 4);
    }
  }

  /**
   * Records PCM conversion output frame count.
   *
   * @param {number} frameCount - Number of 20 ms output frames emitted
   */
  recordPcmFrames(frameCount) {
    if (!this.enabled) return;
    if (typeof frameCount === 'number' && frameCount > 0) {
      this.pcmOutputFrames += frameCount;
    }
  }

  /**
   * Generates a snapshot of capture diagnostics.
   * @returns {Object}
   */
  getSnapshot() {
    if (!this.enabled) {
      return { enabled: false };
    }

    return {
      enabled: true,
      callbackIntervalMs: this.callbackInterval.getSnapshot(),
      capturedBytes: this.capturedBytes,
      capturedFrames: this.capturedFrames,
      pcmOutputFrames: this.pcmOutputFrames
    };
  }

  /**
   * Resets all capture telemetry.
   */
  reset() {
    this.callbackInterval.reset();
    this.capturedBytes = 0;
    this.capturedFrames = 0;
    this.pcmOutputFrames = 0;
    this.lastCallbackHr = 0n;
  }
}

/**
 * Diagnostic telemetry for an independent OutputStream instance.
 */
class OutputStreamTelemetry {
  /**
   * @param {Object} [options]
   * @param {string} [options.name="Output"]
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    this.name = options.name || 'Output';
    this.enabled = options.enabled !== false;

    // Pacer tick interval distribution (nominal: 10 ms via setInterval)
    this.pacerInterval = new DistributionTracker({
      name: `${this.name}_pacerInterval`,
      unit: 'ms',
      bucketThresholds: [8.0, 12.0, 16.0, 20.0],
      bucketLabels: ['<8ms', '8-12ms', '12-16ms', '16-20ms', '>20ms'],
      historyCapacity: 128
    });

    // Native write() execution duration (microseconds)
    this.writeDuration = new DistributionTracker({
      name: `${this.name}_writeDuration`,
      unit: 'us',
      bucketThresholds: [50.0, 200.0, 1000.0, 5000.0],
      bucketLabels: ['<50us', '50-200us', '200-1000us', '1-5ms', '>5ms'],
      historyCapacity: 128
    });

    // Queue depth tracking (sampled on push/pop/tick)
    this.queueDepthFrames = new DistributionTracker({
      name: `${this.name}_queueDepthFrames`,
      unit: 'frames',
      bucketThresholds: [2.0, 4.0, 6.0, 8.0, 10.0],
      bucketLabels: ['<2f', '2-4f', '4-6f', '6-8f', '8-10f', '>=10f'],
      historyCapacity: 128
    });

    // Counts
    this.emptyQueuePacerTicks = 0;
    this.submittedFrames = 0;
    this.lastPacerTickHr = 0n;
  }

  /**
   * Records a pacer tick interval.
   */
  recordPacerTick() {
    if (!this.enabled) return;

    const nowHr = process.hrtime.bigint();
    if (this.lastPacerTickHr !== 0n) {
      const deltaNs = Number(nowHr - this.lastPacerTickHr);
      const deltaMs = deltaNs / 1e6;
      this.pacerInterval.record(deltaMs);
    }
    this.lastPacerTickHr = nowHr;
  }

  /**
   * Records the execution duration of a native rtAudio.write() call.
   *
   * @param {number} durationUs - Duration in microseconds
   */
  recordWriteDuration(durationUs) {
    if (!this.enabled) return;
    this.writeDuration.record(durationUs);
  }

  /**
   * Records that one or more frames were successfully submitted to RtAudio.
   *
   * @param {number} [count=1]
   */
  recordSubmittedFrames(count = 1) {
    if (!this.enabled) return;
    this.submittedFrames += count;
  }

  /**
   * Records an empty-queue pacer tick.
   * Note: This measures that the JavaScript queue was empty when the pacer
   * desired to maintain target lead; it does NOT represent a confirmed hardware underrun.
   */
  recordEmptyQueueTick() {
    if (!this.enabled) return;
    this.emptyQueuePacerTicks++;
  }

  /**
   * Records the current queue depth in frames.
   *
   * @param {number} frames
   */
  recordQueueDepth(frames) {
    if (!this.enabled) return;
    this.queueDepthFrames.record(frames);
  }

  /**
   * Generates a complete snapshot of output diagnostics.
   *
   * @param {Object} [bufferStats] - Stats from AudioBuffer
   * @returns {Object}
   */
  getSnapshot(bufferStats = {}) {
    if (!this.enabled) {
      return { enabled: false };
    }

    const currentFrames = typeof bufferStats.queuedBuffers === 'number'
      ? bufferStats.queuedBuffers
      : (typeof bufferStats.length === 'number' ? bufferStats.length : 0);

    const currentMs = typeof bufferStats.queuedMs === 'number'
      ? bufferStats.queuedMs
      : currentFrames * 20;

    const droppedFrames = typeof bufferStats.droppedBuffers === 'number'
      ? bufferStats.droppedBuffers
      : 0;

    const qSnap = this.queueDepthFrames.getSnapshot();

    return {
      enabled: true,
      name: this.name,
      queueDepth: {
        currentFrames,
        currentMs,
        minFrames: qSnap.count > 0 ? qSnap.min : currentFrames,
        maxFrames: qSnap.count > 0 ? qSnap.max : currentFrames,
        avgFrames: qSnap.count > 0 ? qSnap.avg : currentFrames,
        minMs: qSnap.count > 0 ? Number((qSnap.min * 20).toFixed(1)) : currentMs,
        maxMs: qSnap.count > 0 ? Number((qSnap.max * 20).toFixed(1)) : currentMs,
        avgMs: qSnap.count > 0 ? Number((qSnap.avg * 20).toFixed(1)) : currentMs,
        distribution: qSnap.distribution
      },
      droppedFrames,
      pacerIntervalMs: this.pacerInterval.getSnapshot(),
      emptyQueuePacerTicks: this.emptyQueuePacerTicks,
      submittedFrames: this.submittedFrames,
      writeDurationUs: this.writeDuration.getSnapshot(),
      semantics: {
        emptyQueuePacerTicks: 'Count of 10ms pacer ticks where JavaScript queue was empty; observational software metric, not native driver underrun.',
        writeDurationUs: 'Microseconds spent synchronously inside rtAudio.write(frame).'
      }
    };
  }

  /**
   * Resets all output metrics.
   */
  reset() {
    this.pacerInterval.reset();
    this.writeDuration.reset();
    this.queueDepthFrames.reset();
    this.emptyQueuePacerTicks = 0;
    this.submittedFrames = 0;
    this.lastPacerTickHr = 0n;
  }
}

/**
 * Creates a combined periodic diagnostic snapshot across capture and both outputs.
 *
 * @param {Object} params
 * @param {CaptureTelemetry} params.capture
 * @param {OutputStreamTelemetry} params.stream1
 * @param {OutputStreamTelemetry} params.stream2
 * @param {Object} [params.stream1BufferStats]
 * @param {Object} [params.stream2BufferStats]
 * @returns {Object}
 */
function createTelemetrySnapshot({
  capture,
  stream1,
  stream2,
  stream1BufferStats,
  stream2BufferStats
}) {
  return {
    timestamp: Date.now(),
    uptimeMs: process.uptime ? Math.round(process.uptime() * 1000) : 0,
    capture: capture ? capture.getSnapshot() : { enabled: false },
    output1: stream1 ? stream1.getSnapshot(stream1BufferStats) : { enabled: false },
    output2: stream2 ? stream2.getSnapshot(stream2BufferStats) : { enabled: false },
    meta: {
      frameworkVersion: 'DuoAudio Telemetry 8.1',
      highResolutionTimer: 'process.hrtime.bigint'
    }
  };
}

module.exports = {
  CircularBuffer,
  DistributionTracker,
  CaptureTelemetry,
  OutputStreamTelemetry,
  createTelemetrySnapshot
};
