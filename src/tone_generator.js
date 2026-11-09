/**
 * DuoAudio - Tone Generator Helper
 *
 * Generates continuous, phase-accurate PCM sine wave buffers
 * for audio output testing. Defaults to 48 kHz stereo 32-bit float.
 */

function createToneGenerator(options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const frequency = options.frequency || 440; // 440 Hz (Concert A)
  const channels = options.channels || 2;     // Stereo
  const amplitude = options.amplitude !== undefined ? options.amplitude : 0.1; // -20 dBFS safe level

  let currentPhase = 0;
  const phaseIncrement = (2 * Math.PI * frequency) / sampleRate;

  /**
   * Generates a Node.js Buffer containing interleaved 32-bit float PCM data.
   * @param {number} frameCount Number of sample frames to generate (e.g., 960 for 20ms)
   * @returns {Buffer} Raw PCM buffer of size: frameCount * channels * 4 bytes
   */
  function nextFrame(frameCount) {
    const totalSamples = frameCount * channels;
    const floatArray = new Float32Array(totalSamples);

    for (let frame = 0; frame < frameCount; frame++) {
      const sampleValue = Math.sin(currentPhase) * amplitude;
      currentPhase += phaseIncrement;
      if (currentPhase >= 2 * Math.PI) {
        currentPhase -= 2 * Math.PI;
      }

      // Write identical sample value to all channels (interleaved stereo)
      for (let ch = 0; ch < channels; ch++) {
        floatArray[frame * channels + ch] = sampleValue;
      }
    }

    // Return as a Node.js Buffer sharing the same underlying ArrayBuffer
    return Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
  }

  return {
    nextFrame,
    sampleRate,
    frequency,
    channels,
    amplitude
  };
}

module.exports = {
  createToneGenerator
};
