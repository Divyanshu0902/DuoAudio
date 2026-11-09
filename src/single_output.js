/**
 * DuoAudio - Phase 4B: Single Output Audio Stream Manager
 *
 * Manages the lifecycle of a single WASAPI playback stream using audify@1.10.1.
 * Couples an application-level Bounded Ring Buffer with a paced consumer loop
 * to strictly prevent native C++ queue inflation while maintaining continuous,
 * low-latency playback.
 */

const { RtAudio, RtAudioApi, RtAudioFormat } = require("audify");
const { AudioBuffer } = require("./audio_buffer");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20 ms at 48 kHz
const FLOAT32_BYTES_PER_FRAME = CHANNELS * 4; // 8 bytes per stereo frame
const EXPECTED_BUFFER_BYTES = FRAME_SIZE * FLOAT32_BYTES_PER_FRAME; // 7,680 bytes
const TICK_INTERVAL_MS = 10; // High-resolution pacer interval

class SingleOutput {
  /**
   * @param {Object} options
   * @param {number} [options.volume=0.2] - Software volume limit (0.0 to 1.0, default 0.2 = 20%)
   * @param {number} [options.maxCapacityMs=200] - Bounded buffer capacity in ms
   * @param {number} [options.targetPrebufferMs=80] - Pre-buffer threshold before starting playback
   */
  constructor(options = {}) {
    this.volume = typeof options.volume === "number" ? Math.max(0, Math.min(1, options.volume)) : 0.2;
    this.frameSize = FRAME_SIZE;
    this.sampleRate = SAMPLE_RATE;
    this.channels = CHANNELS;

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
  }

  /**
   * Discovers and verifies the target endpoint, initializes RtAudio, and opens the stream.
   *
   * @param {Object} targetDevice - Object with { id, name }
   * @returns {boolean} True if opened successfully
   */
  open(targetDevice) {
    if (!targetDevice || typeof targetDevice.id !== "number") {
      throw new Error("Invalid target device descriptor provided to SingleOutput.open()");
    }

    this.device = targetDevice;

    try {
      this.rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    } catch (err) {
      this.state = "ERROR";
      this.lastError = err;
      throw new Error(`Failed to initialize RtAudio WASAPI backend: ${err.message}`);
    }

    // Verify target device exists in this RtAudio instance
    const devices = this.rtAudio.getDevices();
    const verifiedDevice = devices.find((d) => d && d.id === targetDevice.id && d.outputChannels > 0);
    if (!verifiedDevice) {
      this.state = "ERROR";
      const err = new Error(`Device ID ${targetDevice.id} ("${targetDevice.name}") not found among active playback endpoints.`);
      this.lastError = err;
      throw err;
    }

    // Apply safe software volume
    this.rtAudio.outputVolume = this.volume;

    try {
      const actualFrameSize = this.rtAudio.openStream(
        { deviceId: targetDevice.id, nChannels: CHANNELS, firstChannel: 0 },
        null,
        RtAudioFormat.RTAUDIO_FLOAT32,
        SAMPLE_RATE,
        FRAME_SIZE,
        "DuoAudio-Single-Output",
        null, // frameOutputCallback omitted for lower overhead
        null,
        0,
        null  // errorCallback omitted to avoid global errorTsfn collision
      );

      if (!this.rtAudio.isStreamOpen()) {
        throw new Error(`Stream failed to open for device ${targetDevice.name}`);
      }

      this.state = "PREBUFFERING";
      return true;
    } catch (err) {
      this.state = "ERROR";
      this.lastError = err;
      this.close();
      throw new Error(`Failed to open WASAPI stream on "${targetDevice.name}": ${err.message}`);
    }
  }

  /**
   * Enqueues a converted 20 ms Float32 buffer.
   * If pre-buffering target is reached, initiates playback and starts the pacer.
   *
   * @param {Buffer} float32Buffer - 7,680-byte 20 ms Float32 buffer
   */
  enqueue(float32Buffer) {
    if (this.state === "STOPPED" || this.state === "ERROR") {
      return;
    }

    if (!Buffer.isBuffer(float32Buffer) || float32Buffer.length !== EXPECTED_BUFFER_BYTES) {
      console.warn(`[SingleOutput] Discarding invalid buffer size: got ${float32Buffer?.length}, expected ${EXPECTED_BUFFER_BYTES}`);
      return;
    }

    this.buffer.push(float32Buffer);

    // If pre-buffering and target lead reached, start output stream
    if (this.state === "PREBUFFERING" && this.buffer.isPrebuffered) {
      this._startPlayback();
    }
  }

  /**
   * Internal method to pre-fill native queue and start stream.
   * @private
   */
  _startPlayback() {
    if (this.state !== "PREBUFFERING") return;

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

      // Start paced consumer loop
      this._startPacer();
    } catch (err) {
      this.state = "ERROR";
      this.lastError = err;
      console.error(`[SingleOutput] Error starting playback on "${this.device?.name}":`, err.message);
      this.close();
    }
  }

  /**
   * High-resolution pacer loop: feeds audify.write() to maintain exactly 2-frame (40 ms)
   * lead in native queue without ever overfilling the C++ unbounded queue.
   * @private
   */
  _startPacer() {
    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
    }

    this.pacerTimer = setInterval(() => {
      if (this.state !== "RUNNING") return;

      try {
        // Stream health check
        if (!this.rtAudio.isStreamRunning()) {
          this.state = "ERROR";
          this.lastError = new Error(`WASAPI stream on "${this.device?.name}" stopped unexpectedly.`);
          console.error(`\n[FATAL] ${this.lastError.message}`);
          this.close();
          return;
        }

        const now = Date.now();
        const elapsed = now - this.playbackStartTime;
        const expectedConsumed = Math.floor(elapsed / 20);
        const targetSubmitted = expectedConsumed + 2; // Target 40 ms lead

        // If the queue was empty and playback starved, realign playbackStartTime
        // so we don't dump a backlog burst when new audio arrives
        if (this.submittedFrames < expectedConsumed) {
          this.playbackStartTime = now - (this.submittedFrames * 20);
        }

        // Paced submission: write frames up to target lead
        let framesWrittenThisTick = 0;
        while (this.submittedFrames < targetSubmitted && this.buffer.length > 0) {
          const frame = this.buffer.pop();
          if (frame) {
            this.rtAudio.write(frame);
            this.submittedFrames++;
            framesWrittenThisTick++;
          }
        }

        // Track underrun ticks (pacer wanted to write to maintain lead, but queue was dry)
        if (this.submittedFrames < targetSubmitted && this.buffer.length === 0) {
          this.underrunTicks++;
        }
      } catch (err) {
        this.state = "ERROR";
        this.lastError = err;
        console.error(`\n[FATAL in Output Pacer]: ${err.message}`);
        this.close();
      }
    }, TICK_INTERVAL_MS);
  }

  /**
   * Idempotent clean stop and release of all stream and queue resources.
   */
  close() {
    if (this.state === "STOPPED") return;
    this.state = "STOPPED";

    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
      this.pacerTimer = null;
    }

    if (this.rtAudio) {
      try {
        if (this.rtAudio.isStreamRunning()) {
          this.rtAudio.stop();
        }
      } catch (e) {}

      try {
        this.rtAudio.clearOutputQueue();
      } catch (e) {}

      try {
        if (this.rtAudio.isStreamOpen()) {
          this.rtAudio.closeStream();
        }
      } catch (e) {}
    }

    this.buffer.clear();
  }

  /**
   * Returns complete diagnostic telemetry for this output stream.
   */
  getDiagnostics() {
    const bufferStats = this.buffer.getStats();
    const isRunning = this.rtAudio && this.state === "RUNNING" ? this.rtAudio.isStreamRunning() : false;

    return {
      deviceName: this.device?.name || "Unknown",
      deviceId: this.device?.id ?? -1,
      state: this.state,
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
  SingleOutput,
  SAMPLE_RATE,
  CHANNELS,
  FRAME_SIZE,
  EXPECTED_BUFFER_BYTES
};
