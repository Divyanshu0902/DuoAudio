/**
 * DuoAudio - Phase 4B: Bounded Audio Ring Buffer
 *
 * Implements a bounded FIFO queue for audio buffers. Prevents unbounded
 * memory accumulation and clock-drift latency buildup by enforcing a strict
 * high-water capacity limit (default 200 ms). When the queue reaches capacity,
 * the oldest buffered frames are dropped to snap latency back to the target
 * real-time lead.
 */

class AudioBuffer {
  /**
   * @param {Object} options
   * @param {number} [options.frameDurationMs=20] - Duration in ms of each buffer (20 ms)
   * @param {number} [options.maxCapacityMs=200] - Maximum queue depth in ms (default 200 ms = 10 buffers)
   * @param {number} [options.targetPrebufferMs=80] - Target prebuffer before starting playback (default 80 ms = 4 buffers)
   */
  constructor(options = {}) {
    this.frameDurationMs = options.frameDurationMs || 20;
    this.maxCapacityMs = options.maxCapacityMs || 200;
    this.targetPrebufferMs = options.targetPrebufferMs || 80;

    this.maxBuffers = Math.max(1, Math.floor(this.maxCapacityMs / this.frameDurationMs));
    this.prebufferCount = Math.max(1, Math.floor(this.targetPrebufferMs / this.frameDurationMs));

    this.queue = [];

    // Diagnostics
    this.totalPushed = 0;
    this.totalPopped = 0;
    this.droppedBuffers = 0;
    this.overflowCount = 0;
  }

  /**
   * Pushes a 20 ms audio buffer into the queue.
   * If the queue is at capacity, the oldest buffer is dropped (drop-oldest policy).
   *
   * @param {Buffer} buffer - 20 ms Float32 PCM buffer
   * @returns {boolean} True if pushed without drop; False if an older buffer was dropped
   */
  push(buffer) {
    let droppedOldest = false;

    if (this.queue.length >= this.maxBuffers) {
      this.queue.shift(); // Drop oldest frame to preserve real-time latency
      this.droppedBuffers++;
      this.overflowCount++;
      droppedOldest = true;
    }

    this.queue.push(buffer);
    this.totalPushed++;
    return !droppedOldest;
  }

  /**
   * Pops the next available 20 ms audio buffer from the queue.
   *
   * @returns {Buffer|null} Audio buffer, or null if queue is empty
   */
  pop() {
    if (this.queue.length === 0) {
      return null;
    }
    this.totalPopped++;
    return this.queue.shift();
  }

  /**
   * Returns whether the queue has accumulated enough frames to satisfy the prebuffer target.
   */
  get isPrebuffered() {
    return this.queue.length >= this.prebufferCount;
  }

  /**
   * Number of buffers currently queued.
   */
  get length() {
    return this.queue.length;
  }

  /**
   * Total queued audio duration in milliseconds.
   */
  get durationMs() {
    return this.queue.length * this.frameDurationMs;
  }

  /**
   * Clears all queued buffers.
   */
  clear() {
    this.queue = [];
  }

  /**
   * Returns snapshot of buffer diagnostics.
   */
  getStats() {
    return {
      queuedBuffers: this.queue.length,
      queuedMs: this.durationMs,
      maxCapacityMs: this.maxCapacityMs,
      targetPrebufferMs: this.targetPrebufferMs,
      totalPushed: this.totalPushed,
      totalPopped: this.totalPopped,
      droppedBuffers: this.droppedBuffers,
      overflowCount: this.overflowCount
    };
  }
}

module.exports = {
  AudioBuffer
};
