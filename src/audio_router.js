/**
 * DuoAudio - Phase 4B: Single-Output System Audio Router
 *
 * Captures Windows system audio via WASAPI loopback using loopback-capture@4.0.0
 * with process-tree exclusion (PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
 * targeting process.pid), converts incoming 16-bit PCM to 32-bit Float PCM,
 * and routes it into a single independently selected playback endpoint via audify@1.10.1.
 */

const loopback = require("loopback-capture");
const { RtAudio, RtAudioApi } = require("audify");
const { PcmConverter, SAMPLE_RATE, CHANNELS } = require("./pcm_converter");
const { SingleOutput } = require("./single_output");

// Parse command line arguments:
// node src/audio_router.js [durationSeconds] [--device <nameQuery>]
const args = process.argv.slice(2);
let durationSec = null;
let deviceFilter = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--device" && i + 1 < args.length) {
    deviceFilter = args[++i].toLowerCase();
  } else {
    const parsed = parseInt(args[i], 10);
    if (!isNaN(parsed) && parsed > 0 && durationSec === null) {
      durationSec = parsed;
    }
  }
}

function formatDb(db) {
  if (!isFinite(db) || db <= -96.0) {
    return "-inf dBFS (silence)";
  }
  return `${db.toFixed(1)} dBFS`;
}

function createMeter(db, width = 14) {
  if (!isFinite(db) || db <= -60) {
    return "[" + "-".repeat(width) + "]";
  }
  const minDb = -60;
  const clampedDb = Math.max(minDb, Math.min(0, db));
  const fraction = (clampedDb - minDb) / (0 - minDb);
  const filled = Math.round(fraction * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function discoverDevices() {
  let rt;
  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    console.error("[FATAL] Could not initialize RtAudio discovery backend:", err.message);
    process.exit(1);
  }

  const allDevices = rt.getDevices();
  const playbackDevices = allDevices.filter((d) => d && d.outputChannels > 0);
  return playbackDevices;
}

function selectTargetDevice(playbackDevices, filter) {
  if (playbackDevices.length === 0) {
    throw new Error("No active playback endpoints found on the system.");
  }

  // 1. If explicit filter provided, match it
  if (filter) {
    const match = playbackDevices.find((d) => (d.name || "").toLowerCase().includes(filter));
    if (match) return match;
    console.warn(`[WARNING] No device matched filter "${filter}". Falling back to default selection.`);
  }

  // 2. Preference: realme Buds T310
  const realme = playbackDevices.find((d) => (d.name || "").toLowerCase().includes("realme"));
  if (realme) return realme;

  // 3. Next preference: Airdopes 161
  const airdopes = playbackDevices.find((d) => (d.name || "").toLowerCase().includes("airdopes"));
  if (airdopes) return airdopes;

  // 4. Default: first non-virtual active playback device
  return playbackDevices[0];
}

function runAudioRouter() {
  console.log("=================================================");
  console.log(" DuoAudio - Phase 4B: Single-Output Audio Router ");
  console.log(" Backend: Windows WASAPI Shared-Mode Loopback    ");
  console.log(" Capture: loopback-capture@4.0.0 (PID-Excluded)  ");
  console.log(" Output : audify@1.10.1 (WASAPI / RtAudio)       ");
  console.log("=================================================\n");

  // Step 1: Discover and select target output endpoint
  console.log("Step 1: Discovering active Windows playback endpoints...");
  const playbackDevices = discoverDevices();
  console.log(`  Found ${playbackDevices.length} active playback endpoint(s):`);
  for (const d of playbackDevices) {
    const isDefault = d.isDefaultOutput ? " [DEFAULT OUTPUT]" : "";
    console.log(`    - [#${d.id}] "${d.name}" (${d.outputChannels} ch, ${d.preferredSampleRate} Hz)${isDefault}`);
  }

  let selectedDevice;
  try {
    selectedDevice = selectTargetDevice(playbackDevices, deviceFilter);
  } catch (err) {
    console.error("\n[FATAL] Device selection failed:", err.message);
    process.exit(1);
  }

  console.log(`\n  >>> SELECTED OUTPUT DESTINATION: "${selectedDevice.name}" (Runtime ID: ${selectedDevice.id}) <<<\n`);

  // Step 2: Print pipeline specifications
  console.log("Pipeline Specifications:");
  console.log(`  Sample Rate              : ${SAMPLE_RATE} Hz`);
  console.log(`  Channels                 : ${CHANNELS} (stereo)`);
  console.log(`  Capture Format           : Signed 16-bit PCM (S16LE)`);
  console.log(`  Output Format            : 32-bit Float PCM (Float32LE)`);
  console.log(`  Output Frame Size        : 960 frames (20 ms at 48 kHz, 7,680 bytes)`);
  console.log(`  Software Output Volume   : 20% (clamped for hearing safety)`);
  console.log(`  Bounded Queue Capacity   : 200 ms (10 buffers of 20 ms)`);
  console.log(`  Target Prebuffer Lead    : 80 ms (4 buffers of 20 ms)`);
  console.log(`  Process Exclusion Mode   : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`);
  console.log(`  Process Exclusion Target : DuoAudio Node.js Process (PID: ${process.pid})`);
  console.log(`  Execution Mode           : ${durationSec ? `Fixed duration (${durationSec}s)` : "Continuous (Press Ctrl+C to stop)"}`);
  console.log();

  // Step 3: Initialize PCM Converter, Single Output Manager, and Capture Engine
  const converter = new PcmConverter({ outputFrameSize: 960 });
  const output = new SingleOutput({
    volume: 0.2, // 20% safe volume
    maxCapacityMs: 200,
    targetPrebufferMs: 80
  });

  let capture;
  try {
    capture = new loopback.LoopbackCapture();
  } catch (err) {
    console.error("[FATAL] Failed to instantiate LoopbackCapture:", err.message);
    process.exit(1);
  }

  // Open output stream
  console.log(`Step 2: Opening output stream on "${selectedDevice.name}"...`);
  try {
    output.open(selectedDevice);
    console.log("  Output stream opened successfully. State: PREBUFFERING\n");
  } catch (err) {
    console.error("[FATAL] Could not open output stream:", err.message);
    process.exit(1);
  }

  // Cumulative Metrics
  let totalCaptureCallbacks = 0;
  let totalCaptureBytes = 0;
  let cumulativePeak = 0;
  let cumulativeSumSquares = 0;
  let cumulativeSamples = 0;
  let cumulativeNonZeroSamples = 0;
  const startTime = Date.now();

  // Rolling 1-second window metrics
  let windowCallbacks = 0;
  let windowBytes = 0;
  let windowPeak = 0;
  let windowSumSquares = 0;
  let windowSamples = 0;

  let isStopping = false;
  let isCleanedUp = false;

  function onCaptureChunk(chunk) {
    if (isStopping) return;

    try {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;

      const chunkBytes = chunk.length;
      totalCaptureCallbacks++;
      totalCaptureBytes += chunkBytes;
      windowCallbacks++;
      windowBytes += chunkBytes;

      // 1. Calculate signal statistics on raw S16 samples
      const sampleCount = chunkBytes / 2;
      cumulativeSamples += sampleCount;
      windowSamples += sampleCount;

      for (let i = 0; i < chunkBytes; i += 2) {
        const raw = chunk.readInt16LE(i);
        if (raw !== 0) {
          cumulativeNonZeroSamples++;
        }
        const norm = raw / 32768.0;
        const absVal = Math.abs(norm);

        if (absVal > cumulativePeak) cumulativePeak = absVal;
        if (absVal > windowPeak) windowPeak = absVal;

        const sq = norm * norm;
        cumulativeSumSquares += sq;
        windowSumSquares += sq;
      }

      // 2. Convert and aggregate into 20 ms Float32 frames
      const outputFrames = converter.processChunk(chunk);

      // 3. Enqueue frames into the output manager
      for (let f = 0; f < outputFrames.length; f++) {
        output.enqueue(outputFrames[f]);
      }
    } catch (err) {
      console.error("\n[ERROR in onCaptureChunk]:", err.message);
    }
  }

  function shutdown(reason = "Clean exit") {
    if (isCleanedUp) return;
    isCleanedUp = true;
    isStopping = true;

    console.log(`\n\nInitiating shutdown (${reason})...`);

    if (statsTimer) clearInterval(statsTimer);
    if (durationTimer) clearTimeout(durationTimer);

    // 1. Stop capture
    try {
      console.log("  Stopping WASAPI loopback capture...");
      capture.stop();
      console.log("  Capture stopped cleanly.");
    } catch (err) {
      console.error("  Error stopping capture:", err.message);
    }

    // 2. Stop and close output stream
    try {
      console.log(`  Closing output stream on "${selectedDevice.name}"...`);
      output.close();
      console.log("  Output stream closed cleanly.");
    } catch (err) {
      console.error("  Error closing output stream:", err.message);
    }

    // 3. Print Final Report
    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const audioCapturedSec = (totalCaptureBytes / (SAMPLE_RATE * 4)).toFixed(2);
    const overallRms = cumulativeSamples > 0 ? Math.sqrt(cumulativeSumSquares / cumulativeSamples) : 0;
    const overallDb = overallRms > 0 ? 20 * Math.log10(overallRms) : -Infinity;
    const outputDiag = output.getDiagnostics();

    console.log("\n=================================================");
    console.log(" Phase 4B: Single-Output Routing Final Report    ");
    console.log("=================================================");
    console.log(`  Wall-Clock Duration     : ${totalElapsedSec} seconds`);
    console.log(`  Target Output Device    : ${selectedDevice.name} (ID: ${selectedDevice.id})`);
    console.log(`  Process Exclusion PID   : ${process.pid} (Excluded successfully)`);
    console.log(`  Capture Callbacks       : ${totalCaptureCallbacks}`);
    console.log(`  Capture Bytes Received  : ${totalCaptureBytes} bytes (${(totalCaptureBytes / 1024).toFixed(1)} KB)`);
    console.log(`  Audio Captured Equiv    : ${audioCapturedSec} seconds`);
    console.log(`  Non-Zero Samples        : ${cumulativeNonZeroSamples} (${cumulativeSamples > 0 ? ((cumulativeNonZeroSamples / cumulativeSamples) * 100).toFixed(2) : "0.00"}%)`);
    console.log(`  Captured Peak Amplitude : ${cumulativePeak.toFixed(4)} (${(cumulativePeak * 100).toFixed(1)}% of full scale)`);
    console.log(`  Captured Overall RMS    : ${formatDb(overallDb)}`);
    console.log(`  Output Buffers Written  : ${outputDiag.submittedFrames} (${outputDiag.audioSecondsPlayed}s audio played)`);
    console.log(`  Buffer Overflows/Drops  : ${outputDiag.queue.droppedBuffers} buffers dropped`);
    console.log(`  Output Underruns        : ${outputDiag.underrunTicks} tick(s)`);
    console.log(`  Final Output State      : ${outputDiag.state}`);
    console.log("=================================================\n");

    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT (Ctrl+C)");
  });

  // Step 4: Start System Audio Capture with PID Exclusion
  console.log(`Step 3: Starting WASAPI loopback capture with PID exclusion (Excluding PID: ${process.pid})...`);
  try {
    capture.startSystemAudio(onCaptureChunk, process.pid);
    console.log("  Capture running with process exclusion active.");
    console.log("  >>> Play audio in an application (Brave, YouTube, VLC) to test routing. <<<\n");
  } catch (err) {
    console.error("[FATAL] Failed to start system audio capture:", err.message);
    output.close();
    process.exit(1);
  }

  // Periodic 1-second diagnostic logger
  const statsTimer = setInterval(() => {
    if (isStopping) return;

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const windowRms = windowSamples > 0 ? Math.sqrt(windowSumSquares / windowSamples) : 0;
    const windowDb = windowRms > 0 ? 20 * Math.log10(windowRms) : -Infinity;
    const meter = createMeter(windowDb, 12);
    const outputDiag = output.getDiagnostics();

    if (windowCallbacks === 0) {
      console.log(
        `[${elapsedSec}s] Waiting for audio... (Silence gate active) | Output: ${outputDiag.state} | Queue: ${outputDiag.queue.queuedMs}ms`
      );
    } else {
      console.log(
        `[${elapsedSec}s] ${meter} ${formatDb(windowDb).padEnd(16)} | ` +
        `Peak: ${(windowPeak * 100).toFixed(1).padStart(4)}% | ` +
        `Cap: ${windowCallbacks.toString().padStart(3)} buf | ` +
        `Queue: ${outputDiag.queue.queuedMs.toString().padStart(3)}ms (${outputDiag.queue.queuedBuffers} buf) | ` +
        `Out: ${outputDiag.submittedFrames.toString().padStart(4)} frames (${outputDiag.audioSecondsPlayed}s) | ` +
        `Drops: ${outputDiag.queue.droppedBuffers} | ` +
        `Stream: ${outputDiag.state}`
      );
    }

    // Reset window metrics
    windowCallbacks = 0;
    windowBytes = 0;
    windowPeak = 0;
    windowSumSquares = 0;
    windowSamples = 0;
  }, 1000);

  // Duration timer
  let durationTimer = null;
  if (durationSec) {
    durationTimer = setTimeout(() => {
      shutdown(`Configured duration of ${durationSec}s reached`);
    }, durationSec * 1000);
  }
}

runAudioRouter();
