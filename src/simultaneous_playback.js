/**
 * DuoAudio - Phase 2B: Simultaneous Audio Playback Proof of Concept
 *
 * Simultaneously streams a synthesized 440 Hz sine wave tone
 * (48 kHz, stereo, 32-bit float) to two independently selected
 * Bluetooth output endpoints (realme Buds T310 and Airdopes 161).
 */

const { RtAudio, RtAudioApi, RtAudioFormat } = require("audify");
const { createToneGenerator } = require("./tone_generator");

const TARGET_1_NAME = "realme Buds T310";
const TARGET_1_KEY = "realme";

const TARGET_2_NAME = "Airdopes 161";
const TARGET_2_KEY = "airdopes";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20 ms at 48 kHz
const BYTES_PER_SAMPLE = 4; // Float32 = 4 bytes
const EXPECTED_FRAME_BYTES = FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE; // 7,680 bytes
const DEFAULT_DURATION_MS = 5000; // 5 seconds
const PREBUFFER_FRAMES = 5; // 100 ms pre-buffer for smooth playback
const TICK_INTERVAL_MS = 20; // Producer loop interval
const SAFE_OUTPUT_VOLUME = 0.2; // 20% volume limit
const TONE_AMPLITUDE = 0.1; // -20 dBFS safe listening level
const TONE_FREQUENCY = 440; // 440 Hz (Concert A)

function findTargetDevices(discoveryRt) {
  const allDevices = discoveryRt.getDevices();

  let dev1 = null;
  let dev2 = null;

  for (const dev of allDevices) {
    if (!dev || dev.outputChannels <= 0) continue;
    const nameLower = (dev.name || "").toLowerCase();

    if (!dev1 && nameLower.includes(TARGET_1_KEY)) {
      dev1 = dev;
    } else if (!dev2 && nameLower.includes(TARGET_2_KEY)) {
      dev2 = dev;
    }
  }

  return { dev1, dev2 };
}

function verifyBuffer(buf, label) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error(`[${label}] Audio payload is not a Buffer instance.`);
  }
  if (buf.length !== EXPECTED_FRAME_BYTES) {
    throw new Error(
      `[${label}] Buffer size mismatch: got ${buf.length} bytes, expected ${EXPECTED_FRAME_BYTES} bytes (${FRAME_SIZE} frames * ${CHANNELS} channels * ${BYTES_PER_SAMPLE} bytes).`
    );
  }
}

async function runSimultaneousPlayback(durationMs = DEFAULT_DURATION_MS) {
  console.log("=================================================");
  console.log(" DuoAudio - Phase 2B: Simultaneous Playback PoC ");
  console.log(" Backend: Windows Audio Session API (WASAPI)    ");
  console.log("=================================================\n");

  // 1. Discover target devices using a discovery instance
  console.log("Step 1: Discovering active playback endpoints via WASAPI...");
  let discoveryRt;
  try {
    discoveryRt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    console.error("[FATAL] Failed to initialize discovery RtAudio backend:", err.message);
    process.exit(1);
  }

  const { dev1, dev2 } = findTargetDevices(discoveryRt);

  if (!dev1) {
    console.error(`[FATAL] Target device 1 (${TARGET_1_NAME}) was not found among active playback endpoints.`);
    console.error("        Ensure the device is powered on, removed from case, and connected via Bluetooth.");
    process.exit(1);
  }

  if (!dev2) {
    console.error(`[FATAL] Target device 2 (${TARGET_2_NAME}) was not found among active playback endpoints.`);
    console.error("        Ensure the device is powered on, removed from case, and connected via Bluetooth.");
    process.exit(1);
  }

  console.log(`  Target 1 matched: "${dev1.name}"`);
  console.log(`    Runtime ID: ${dev1.id} | Channels: ${dev1.outputChannels} | Preferred Rate: ${dev1.preferredSampleRate} Hz`);
  console.log(`  Target 2 matched: "${dev2.name}"`);
  console.log(`    Runtime ID: ${dev2.id} | Channels: ${dev2.outputChannels} | Preferred Rate: ${dev2.preferredSampleRate} Hz`);
  console.log();

  // 2. Initialize two independent RtAudio instances
  console.log("Step 2: Initializing two independent RtAudio stream instances...");
  let stream1 = null;
  let stream2 = null;

  try {
    stream1 = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    stream2 = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    console.error("[FATAL] Failed to create independent RtAudio instances:", err.message);
    process.exit(1);
  }

  // Cross-verify device IDs across instances
  const stream1Devices = stream1.getDevices();
  const stream2Devices = stream2.getDevices();
  const dev1InStream1 = stream1Devices.find((d) => d.id === dev1.id);
  const dev2InStream2 = stream2Devices.find((d) => d.id === dev2.id);

  if (!dev1InStream1 || !dev2InStream2) {
    console.error("[FATAL] Device ID cross-verification failed: runtime IDs from discovery do not match stream instances.");
    process.exit(1);
  }
  console.log("  Runtime IDs successfully verified across independent RtAudio instances.");

  // Set safe software volume limits
  stream1.outputVolume = SAFE_OUTPUT_VOLUME;
  stream2.outputVolume = SAFE_OUTPUT_VOLUME;
  console.log(`  Software volume clamped to ${(SAFE_OUTPUT_VOLUME * 100).toFixed(0)}% on both streams.`);

  // Setup cleanup handler
  let isCleanedUp = false;
  function cleanup() {
    if (isCleanedUp) return;
    isCleanedUp = true;
    console.log("\nExecuting clean shutdown of audio streams...");

    if (stream1) {
      try {
        if (stream1.isStreamRunning()) stream1.stop();
      } catch (e) {
        console.error("  Error stopping stream 1:", e.message);
      }
      try {
        stream1.clearOutputQueue();
      } catch (e) {}
      try {
        if (stream1.isStreamOpen()) stream1.closeStream();
        console.log("  Stream 1 closed cleanly.");
      } catch (e) {
        console.error("  Error closing stream 1:", e.message);
      }
    }

    if (stream2) {
      try {
        if (stream2.isStreamRunning()) stream2.stop();
      } catch (e) {
        console.error("  Error stopping stream 2:", e.message);
      }
      try {
        stream2.clearOutputQueue();
      } catch (e) {}
      try {
        if (stream2.isStreamOpen()) stream2.closeStream();
        console.log("  Stream 2 closed cleanly.");
      } catch (e) {
        console.error("  Error closing stream 2:", e.message);
      }
    }
  }

  process.on("SIGINT", () => {
    console.log("\nPlayback interrupted by user (SIGINT).");
    cleanup();
    process.exit(0);
  });

  // 3. Open both streams
  console.log("\nStep 3: Opening output streams...");
  try {
    const actualFrames1 = stream1.openStream(
      { deviceId: dev1.id, nChannels: CHANNELS, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_FLOAT32,
      SAMPLE_RATE,
      FRAME_SIZE,
      "DuoAudio-Stream-1",
      null,
      null,
      0,
      null // errorCallback omitted to avoid global errorTsfn collision
    );

    const actualFrames2 = stream2.openStream(
      { deviceId: dev2.id, nChannels: CHANNELS, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_FLOAT32,
      SAMPLE_RATE,
      FRAME_SIZE,
      "DuoAudio-Stream-2",
      null,
      null,
      0,
      null // errorCallback omitted to avoid global errorTsfn collision
    );

    if (!stream1.isStreamOpen()) {
      throw new Error(`Stream 1 failed to open for device ${dev1.name}`);
    }
    if (!stream2.isStreamOpen()) {
      throw new Error(`Stream 2 failed to open for device ${dev2.name}`);
    }

    console.log(`  Stream 1 opened for "${dev1.name}" (Frame size: ${actualFrames1} samples)`);
    console.log(`  Stream 2 opened for "${dev2.name}" (Frame size: ${actualFrames2} samples)`);
  } catch (err) {
    console.error("[FATAL] Stream opening failed:", err.message);
    cleanup();
    process.exit(1);
  }

  // 4. Initialize tone generator (440 Hz sine wave, amplitude 0.1)
  console.log("\nStep 4: Initializing tone generator...");
  console.log(`  Waveform: Sine wave at ${TONE_FREQUENCY} Hz (Concert A)`);
  console.log(`  Format: 48 kHz, stereo, 32-bit float, amplitude ${TONE_AMPLITUDE} (-20 dBFS)`);
  const toneGen = createToneGenerator({
    sampleRate: SAMPLE_RATE,
    frequency: TONE_FREQUENCY,
    channels: CHANNELS,
    amplitude: TONE_AMPLITUDE
  });

  // 5. Pre-buffer initial frames
  console.log(`\nStep 5: Pre-buffering ${PREBUFFER_FRAMES} frames (${PREBUFFER_FRAMES * (FRAME_SIZE / SAMPLE_RATE * 1000)} ms)...`);
  try {
    for (let i = 0; i < PREBUFFER_FRAMES; i++) {
      const frame = toneGen.nextFrame(FRAME_SIZE);
      verifyBuffer(frame, "Prebuffer");
      stream1.write(frame);
      stream2.write(frame);
    }
    console.log("  Pre-buffering complete.");
  } catch (err) {
    console.error("[FATAL] Pre-buffering failed:", err.message);
    cleanup();
    process.exit(1);
  }

  // 6. Start streams sequentially
  console.log("\nStep 6: Starting both streams...");
  try {
    stream1.start();
    stream2.start();

    if (!stream1.isStreamRunning() || !stream2.isStreamRunning()) {
      throw new Error("One or both streams failed to transition to running state.");
    }

    console.log("  Stream 1 running: YES");
    console.log("  Stream 2 running: YES");
    console.log(`\n>>> Simultaneous playback active for ${durationMs / 1000} seconds <<<`);
    console.log("    (You should hear a continuous, clear 440 Hz tone in BOTH earbuds)\n");
  } catch (err) {
    console.error("[FATAL] Failed to start streams:", err.message);
    cleanup();
    process.exit(1);
  }

  // 7. Time-budgeted producer loop
  // Ensures audio queues are never starved even when Node.js event-loop timers experience jitter
  const startTime = Date.now();
  let totalFramesStream1 = PREBUFFER_FRAMES;
  let totalFramesStream2 = PREBUFFER_FRAMES;
  let timerTicks = 0;
  let delayedTicks = 0;
  let lastTickTime = startTime;

  try {
    await new Promise((resolve, reject) => {
      const intervalTimer = setInterval(() => {
        try {
          const now = Date.now();
          const elapsed = now - startTime;
          const tickDelta = now - lastTickTime;
          lastTickTime = now;
          timerTicks++;

          if (tickDelta > TICK_INTERVAL_MS + 10) {
            delayedTicks++;
          }

          // Check for completion
          if (elapsed >= durationMs) {
            clearInterval(intervalTimer);
            resolve();
            return;
          }

          // Monitor stream health
          if (!stream1.isStreamRunning()) {
            clearInterval(intervalTimer);
            reject(new Error(`Stream 1 (${dev1.name}) stopped unexpectedly during playback.`));
            return;
          }
          if (!stream2.isStreamRunning()) {
            clearInterval(intervalTimer);
            reject(new Error(`Stream 2 (${dev2.name}) stopped unexpectedly during playback.`));
            return;
          }

          // Calculate how many frames should be buffered ahead (target lead: 5 frames = 100ms)
          const targetFrames = Math.floor((elapsed / 1000) * (SAMPLE_RATE / FRAME_SIZE)) + PREBUFFER_FRAMES;

          // Catch up if timer was delayed
          while (totalFramesStream1 < targetFrames && (Date.now() - startTime) < durationMs) {
            const frame = toneGen.nextFrame(FRAME_SIZE);
            verifyBuffer(frame, "ProducerLoop");

            stream1.write(frame);
            totalFramesStream1++;

            stream2.write(frame);
            totalFramesStream2++;
          }

          // Display visual progress
          if (timerTicks % 15 === 0) {
            const sec = (elapsed / 1000).toFixed(1);
            process.stdout.write(`  [Streaming...] ${sec}s / ${(durationMs / 1000).toFixed(1)}s elapsed\r`);
          }
        } catch (err) {
          clearInterval(intervalTimer);
          reject(err);
        }
      }, TICK_INTERVAL_MS);
    });

    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const audioGeneratedSec = (totalFramesStream1 * (FRAME_SIZE / SAMPLE_RATE)).toFixed(2);

    console.log(`\n\nStep 7: Playback loop finished.`);
    console.log(`  Actual wall-clock time: ${totalElapsedSec} seconds`);
    console.log(`  Frames submitted (S1) : ${totalFramesStream1} (${audioGeneratedSec}s audio equivalent)`);
    console.log(`  Frames submitted (S2) : ${totalFramesStream2} (${audioGeneratedSec}s audio equivalent)`);
    console.log(`  Producer timer ticks  : ${timerTicks} (Delayed >10ms: ${delayedTicks})`);
    console.log(`  Stream 1 operational  : ${stream1.isStreamRunning() ? "YES" : "NO"}`);
    console.log(`  Stream 2 operational  : ${stream2.isStreamRunning() ? "YES" : "NO"}`);

  } catch (err) {
    console.error("\n[ERROR during playback loop]:", err.message);
    cleanup();
    process.exit(1);
  }

  // 8. Clean shutdown
  cleanup();
  console.log("\nPhase 2B execution completed successfully.");
}

// Parse optional duration argument
const argDuration = parseInt(process.argv[2], 10);
const duration = !isNaN(argDuration) && argDuration > 0 ? argDuration : DEFAULT_DURATION_MS;

runSimultaneousPlayback(duration);
