/**
 * DuoAudio - Phase 4B: PCM Sample Converter & Frame Aggregator
 *
 * Converts incoming WASAPI loopback 16-bit signed integer stereo PCM chunks
 * (48 kHz, 2 channels, S16LE) to 32-bit floating-point stereo PCM buffers
 * (48 kHz, 2 channels, Float32LE). Aggregates variable-sized capture chunks
 * (typically 10 ms = 480 frames = 1,920 bytes) into uniform 20 ms output frames
 * (960 frames = 1,920 samples = 7,680 bytes Float32), preserving exact sample
 * continuity and alignment across callback boundaries.
 */

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const S16_BYTES_PER_SAMPLE = 2;
const S16_BYTES_PER_FRAME = CHANNELS * S16_BYTES_PER_SAMPLE; // 4 bytes per stereo frame
const FLOAT32_BYTES_PER_SAMPLE = 4;
const FLOAT32_BYTES_PER_FRAME = CHANNELS * FLOAT32_BYTES_PER_SAMPLE; // 8 bytes per stereo frame

const FULL_SCALE_INT16 = 32768.0;

class PcmConverter {
  /**
   * @param {Object} options
   * @param {number} [options.outputFrameSize=960] - Number of stereo frames per output buffer (960 = 20 ms at 48 kHz)
   */
  constructor(options = {}) {
    this.outputFrameSize = options.outputFrameSize || 960;
    this.outputSampleCount = this.outputFrameSize * CHANNELS; // 1,920 samples
    this.requiredInputBytes = this.outputFrameSize * S16_BYTES_PER_FRAME; // 3,840 bytes S16LE

    // Residual byte accumulator for cross-callback sample continuity
    this.accumulator = Buffer.alloc(0);

    // Diagnostics
    this.totalInputBytes = 0;
    this.totalOutputFrames = 0;
    this.misalignedChunksCount = 0;
  }

  /**
   * Ingests a raw capture Buffer from loopback-capture.
   * Converts and aggregates into zero or more 20 ms Float32 output buffers.
   *
   * @param {Buffer} chunk - Raw 16-bit signed integer PCM buffer
   * @returns {Buffer[]} Array of converted 20 ms Float32 Buffer objects (7,680 bytes each)
   */
  processChunk(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return [];
    }

    // Verify 4-byte stereo frame boundary alignment
    let cleanChunk = chunk;
    const remainder = chunk.length % S16_BYTES_PER_FRAME;
    if (remainder !== 0) {
      this.misalignedChunksCount++;
      const alignedLength = chunk.length - remainder;
      cleanChunk = chunk.subarray(0, alignedLength);
    }

    this.totalInputBytes += cleanChunk.length;

    // Concatenate with any residual bytes from previous callback
    if (this.accumulator.length > 0) {
      this.accumulator = Buffer.concat([this.accumulator, cleanChunk]);
    } else {
      this.accumulator = cleanChunk;
    }

    const outputBuffers = [];

    // Extract all complete 20 ms frames (3,840 S16 bytes -> 7,680 Float32 bytes)
    while (this.accumulator.length >= this.requiredInputBytes) {
      const s16Slice = this.accumulator.subarray(0, this.requiredInputBytes);
      this.accumulator = this.accumulator.subarray(this.requiredInputBytes);

      const float32Array = new Float32Array(this.outputSampleCount);

      // Fast conversion: S16LE [-32768, 32767] -> Float32 [-1.0, 1.0]
      for (let i = 0; i < this.outputSampleCount; i++) {
        const rawInt16 = s16Slice.readInt16LE(i * S16_BYTES_PER_SAMPLE);
        float32Array[i] = rawInt16 / FULL_SCALE_INT16;
      }

      // Create Buffer sharing the Float32Array's memory
      const outBuf = Buffer.from(
        float32Array.buffer,
        float32Array.byteOffset,
        float32Array.byteLength
      );

      outputBuffers.push(outBuf);
      this.totalOutputFrames++;
    }

    return outputBuffers;
  }

  /**
   * Resets the accumulator and statistics.
   */
  reset() {
    this.accumulator = Buffer.alloc(0);
    this.totalInputBytes = 0;
    this.totalOutputFrames = 0;
    this.misalignedChunksCount = 0;
  }

  /**
   * Returns current accumulator residual size in bytes.
   */
  get residualBytes() {
    return this.accumulator.length;
  }
}

module.exports = {
  PcmConverter,
  SAMPLE_RATE,
  CHANNELS,
  S16_BYTES_PER_FRAME,
  FLOAT32_BYTES_PER_FRAME
};
