/**
 * DuoAudio - Output Stream Manager
 *
 * Manages the lifecycle of an independent WASAPI playback stream using audify@1.10.1.
 * Integrates an application-level Bounded Ring Buffer (AudioBuffer) with an
 * independent wall-clock rate-pacer loop to strictly prevent native C++ queue
 * inflation while delivering low-latency, glitch-free audio playback.
 *
 * Fully encapsulates failure detection and cleanup so that multiple OutputStream
 * instances operate with complete mutual failure isolation.
 */

const { RtAudio, RtAudioApi, RtAudioFormat } = require("audify");
const { AudioBuffer } = require("./audio_buffer");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20 ms at 48 kHz
const FLOAT32_BYTES_PER_FRAME = CHANNELS * 4; // 8 bytes per stereo frame
const EXPECTED_BUFFER_BYTES = FRAME_SIZE * FLOAT32_BYTES_PER_FRAME; // 7,680 bytes
const TICK_INTERVAL_MS = 10; // High-resolution pacer interval

class OutputStream {
  /**
   * @param {Object} options
   * @param {string} [options.name="Output"] - Descriptive label (e.g. "Output A")
   * @param {number} [options.volume=1.0] - Software volume limit (0.0 to 1.0, default 1.0 = unity gain)
   * @param {number} [options.maxCapacityMs=200] - Bounded buffer capacity in ms
   * @param {number} [options.targetPrebufferMs=80] - Pre-buffer threshold before starting playback
   * @param {Function} [options.onError=null] - Asynchronous failure callback: (error, stream) => void
   */
  constructor(options = {}) {
    this.name = options.name || "Output";
    this.volume = typeof options.volume === "number" ? Math.max(0, Math.min(1, options.volume)) : 1.0;
    this.frameSize = FRAME_SIZE;
    this.sampleRate = SAMPLE_RATE;
    this.channels = CHANNELS;
    this.onError = typeof options.onError === "function" ? options.onError : null;

    this.buffer = new AudioBuffer({
      frameDurationMs: 20,
      maxCapacityMs: options.maxCapacityMs || 200,
      targetPrebufferMs: options.targetPrebufferMs || 80
    });

    this.rtAudio = null;
    this.device = null;
    this.state = "IDLE"; // IDLE, PREBUFFERING, RUNNING, STOPPED, ERROR

    this.pacerTimer = null;
    this.playbackStartTime = 0;
    this.submittedFrames = 0;
    this.underrunTicks = 0;
    this.lastError = null;

    this.isClosing = false;
    this.isClosed = false;
    this.isError = false;
  }

  /**
   * Whether the stream is currently active (either prebuffering or running).
   * @returns {boolean}
   */
  get isActive() {
    return (this.state === "RUNNING" || this.state === "PREBUFFERING") && !this.isClosed && !this.isError;
  }

  /**
   * Discovers and verifies the target endpoint, initializes RtAudio, and opens the stream.
   *
   * @param {Object} targetDevice - Object with { id, name }
   * @returns {boolean} True if opened successfully
   */
  open(targetDevice) {
    if (!targetDevice || typeof targetDevice.id !== "number") {
      throw new Error(`[${this.name}] Invalid target device descriptor provided to open()`);
    }

    this.device = targetDevice;

    try {
      this.rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    } catch (err) {
      this.state = "ERROR";
      this.isError = true;
      this.lastError = err;
      throw new Error(`[${this.name}] Failed to initialize RtAudio WASAPI backend: ${err.message}`);
    }

    // Verify target device exists in this RtAudio instance and has active output channels
    const devices = this.rtAudio.getDevices();
    const verifiedDevice = devices.find((d) => d && d.id === targetDevice.id && d.outputChannels > 0);
    if (!verifiedDevice) {
      this.state = "ERROR";
      this.isError = true;
      const err = new Error(`[${this.name}] Device ID ${targetDevice.id} ("${targetDevice.name}") not found among active playback endpoints.`);
      this.lastError = err;
      throw err;
    }

    // Apply safe software volume
    this.rtAudio.outputVolume = this.volume;

    try {
      this.rtAudio.openStream(
        { deviceId: targetDevice.id, nChannels: CHANNELS, firstChannel: 0 },
        null,
        RtAudioFormat.RTAUDIO_FLOAT32,
        SAMPLE_RATE,
        FRAME_SIZE,
        `DuoAudio-${this.name}`,
        null, // inputCallback omitted
        null, // frameOutputCallback omitted for lower overhead
        0,
        null  // errorCallback omitted to avoid global errorTsfn collisions
      );

      if (!this.rtAudio.isStreamOpen()) {
        throw new Error(`[${this.name}] Stream failed to open for device "${targetDevice.name}"`);
      }

      this.state = "PREBUFFERING";
      return true;
    } catch (err) {
      this.state = "ERROR";
      this.isError = true;
      this.lastError = err;
      this.close();
      throw new Error(`[${this.name}] Failed to open WASAPI stream on "${targetDevice.name}": ${err.message}`);
    }
  }

  /**
   * Enqueues a converted 20 ms Float32 buffer into the bounded ring buffer.
   * Note: The input buffer is referentially shared across outputs; consumers must NOT mutate it.
   *
   * @param {Buffer} float32Buffer - 7,680-byte 20 ms Float32 buffer
   */
  enqueue(float32Buffer) {
    if (this.isClosed || this.isError || (this.state !== "PREBUFFERING" && this.state !== "RUNNING")) {
      return;
    }

    if (!Buffer.isBuffer(float32Buffer) || float32Buffer.length !== EXPECTED_BUFFER_BYTES) {
      console.warn(`[${this.name}] Discarding invalid buffer size: got ${float32Buffer?.length}, expected ${EXPECTED_BUFFER_BYTES}`);
      return;
    }

    this.buffer.push(float32Buffer);

    // If pre-buffering and target threshold reached, transition to playback
    if (this.state === "PREBUFFERING" && this.buffer.isPrebuffered) {
      this._startPlayback();
    }
  }

  /**
   * Internal method to pre-fill native queue and start stream.
   * @private
   */
  _startPlayback() {
    if (this.state !== "PREBUFFERING" || this.isClosed || this.isError) return;

    try {
      // Pre-fill native queue with initial 2 frames (40 ms lead) to prevent initial startup underrun
      const initialLeadFrames = Math.min(2, this.buffer.length);
      for (let i = 0; i < initialLeadFrames; i++) {
        const frame = this.buffer.pop();
        if (frame) {
          this.rtAudio.write(frame);
          this.submittedFrames++;
        }
      }

      this.rtAudio.start();

      if (!this.rtAudio.isStreamRunning()) {
        throw new Error("Stream failed to transition to running state.");
      }

      this.playbackStartTime = Date.now();
      this.state = "RUNNING";

      // Start independent high-resolution rate pacer
      this._startPacer();
    } catch (err) {
      this._handleFailure(err, "starting playback");
    }
  }

  /**
   * High-resolution pacer loop: feeds audify.write() based on independent wall-clock
   * elapsed time to maintain an estimated 2-frame (40 ms) native lead without native
   * queue inflation.
   * @private
   */
  _startPacer() {
    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
    }

    this.pacerTimer = setInterval(() => {
      if (this.state !== "RUNNING" || this.isClosed || this.isError) return;

      try {
        // Stream health check: detect unexpected stream termination or driver invalidation
        if (!this.rtAudio.isStreamRunning()) {
          const err = new Error(`WASAPI stream on "${this.device?.name}" stopped unexpectedly.`);
          this._handleFailure(err, "health check");
          return;
        }

        const now = Date.now();
        const elapsed = now - this.playbackStartTime;
        const expectedConsumed = Math.floor(elapsed / 20);
        const targetSubmitted = expectedConsumed + 2; // Target 40 ms estimated native lead

        // If the queue ran dry and playback starved, realign playbackStartTime
        // so we don't dump a backlog burst when new audio arrives
        if (this.submittedFrames < expectedConsumed) {
          this.playbackStartTime = now - (this.submittedFrames * 20);
        }

        // Paced submission: write frames up to target lead
        while (this.submittedFrames < targetSubmitted && this.buffer.length > 0) {
          const frame = this.buffer.pop();
          if (frame) {
            try {
              this.rtAudio.write(frame);
              this.submittedFrames++;
            } catch (writeErr) {
              this._handleFailure(writeErr, "synchronous write");
              return;
            }
          }
        }

        // Track underrun ticks (pacer wanted to write to maintain lead, but queue was dry)
        if (this.submittedFrames < targetSubmitted && this.buffer.length === 0) {
          this.underrunTicks++;
        }
      } catch (err) {
        this._handleFailure(err, "pacer tick");
      }
    }, TICK_INTERVAL_MS);
  }

  /**
   * Centralized failure handler. Guarantees isolated shutdown of this stream
   * without affecting any other concurrent stream.
   * @private
   */
  _handleFailure(err, context = "runtime") {
    if (this.isClosed && this.isError) return;

    this.isError = true;
    this.state = "ERROR";
    this.lastError = err;

    console.error(`\n[WARNING: ${this.name} FAILED (${context})] "${this.device?.name}": ${err.message}`);

    this.close();

    if (this.onError) {
      try {
        this.onError(err, this);
      } catch (cbErr) {
        console.error(`[${this.name}] Error in onError callback:`, cbErr.message);
      }
    }
  }

  /**
   * Idempotent clean stop and release of all stream, timer, and queue resources.
   * Uses separate defensive try/catch blocks for each native operation to ensure
   * complete teardown even if individual native calls fail.
   */
  close() {
    if (this.isClosed) return;
    this.isClosing = true;

    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
      this.pacerTimer = null;
    }

    if (this.rtAudio) {
      // 1. Clear native output queue
      try {
        this.rtAudio.clearOutputQueue();
      } catch (e) {
        // Suppress cleanup warning
      }

      // 2. Stop native stream
      try {
        if (this.rtAudio.isStreamRunning()) {
          this.rtAudio.stop();
        }
      } catch (e) {
        // Suppress already-stopped warnings
      }

      // 3. Close native stream
      try {
        if (this.rtAudio.isStreamOpen()) {
          this.rtAudio.closeStream();
        }
      } catch (e) {
        // Suppress already-closed warnings
      }
    }

    this.buffer.clear();
    this.isClosed = true;
    this.isClosing = false;
    if (!this.isError) {
      this.state = "STOPPED";
    }
  }

  /**
   * Returns complete diagnostic telemetry for this output stream.
   */
  getDiagnostics() {
    const bufferStats = this.buffer.getStats();
    const isRunning = this.rtAudio && this.state === "RUNNING" ? this.rtAudio.isStreamRunning() : false;

    return {
      name: this.name,
      deviceName: this.device?.name || "Unknown",
      deviceId: this.device?.id ?? -1,
      state: this.state,
      isActive: this.isActive,
      isStreamRunning: isRunning,
      volumePercent: Math.round(this.volume * 100),
      submittedFrames: this.submittedFrames,
      audioSecondsPlayed: (this.submittedFrames * 0.02).toFixed(2),
      underrunTicks: this.underrunTicks,
      queue: bufferStats
    };
  }
}

module.exports = {
  OutputStream,
  SAMPLE_RATE,
  CHANNELS,
  FRAME_SIZE,
  EXPECTED_BUFFER_BYTES
};
