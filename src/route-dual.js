/**
 * DuoAudio - Phase 4C: Dual-Output Simultaneous Audio Router (with Phase 4C.1 Mute Management)
 *
 * Captures Windows system audio via WASAPI loopback using loopback-capture@4.0.0
 * with process-tree exclusion (PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
 * targeting process.pid), converts incoming 16-bit PCM to 32-bit Float PCM,
 * and routes it concurrently to TWO independently selected playback endpoints
 * using audify@1.10.1 (WASAPI shared mode).
 *
 * Enforces:
 * - Automatic default render endpoint muting & restoration (Phase 4C.1).
 * - Independent bounded queues (200 ms max, 80 ms prebuffer, drop-oldest overflow).
 * - Independent wall-clock pacing (10 ms tick, maintaining <= 40 ms native lead).
 * - Referential JavaScript buffer sharing with synchronous native copying.
 * - Strict failure isolation (an error on one output does not crash the other).
 * - Pre-flight detection and warning for default-output conflicts.
 * - Side-by-side dual telemetry reporting.
 */

const loopback = require("loopback-capture");
const { RtAudio, RtAudioApi } = require("audify");
const { PcmConverter, SAMPLE_RATE, CHANNELS } = require("./pcm_converter");
const { OutputStream } = require("./output_stream");
const { EndpointMuteManager } = require("./endpoint_mute");

// Parse CLI arguments:
// node src/route-dual.js [durationSec] [--device1 <nameOrId>] [--device2 <nameOrId>] [--vol1 <0.0-1.0>] [--vol2 <0.0-1.0>] [--allow-conflict] [--no-mute]
const args = process.argv.slice(2);
let durationSec = null;
let device1Filter = null;
let device2Filter = null;
let vol1 = 1.0;
let vol2 = 1.0;
let allowConflict = false;
let noMute = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--device1" && i + 1 < args.length) {
    device1Filter = args[++i];
  } else if (arg === "--device2" && i + 1 < args.length) {
    device2Filter = args[++i];
  } else if (arg === "--vol1") {
    if (i + 1 >= args.length) {
      console.error("[FATAL] Missing value for --vol1 (expected a number between 0.0 and 1.0)");
      process.exit(1);
    }
    const rawVal = args[++i];
    const parsedVal = parseFloat(rawVal);
    if (isNaN(parsedVal) || parsedVal < 0.0 || parsedVal > 1.0) {
      console.error(`[FATAL] Invalid --vol1: value must be a number between 0.0 and 1.0 (got: "${rawVal}")`);
      process.exit(1);
    }
    vol1 = parsedVal;
  } else if (arg === "--vol2") {
    if (i + 1 >= args.length) {
      console.error("[FATAL] Missing value for --vol2 (expected a number between 0.0 and 1.0)");
      process.exit(1);
    }
    const rawVal = args[++i];
    const parsedVal = parseFloat(rawVal);
    if (isNaN(parsedVal) || parsedVal < 0.0 || parsedVal > 1.0) {
      console.error(`[FATAL] Invalid --vol2: value must be a number between 0.0 and 1.0 (got: "${rawVal}")`);
      process.exit(1);
    }
    vol2 = parsedVal;
  } else if (arg === "--allow-conflict") {
    allowConflict = true;
  } else if (arg === "--no-mute") {
    noMute = true;
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else {
    const parsed = parseInt(arg, 10);
    if (!isNaN(parsed) && parsed > 0 && durationSec === null) {
      durationSec = parsed;
    }
  }
}

function printHelp() {
  console.log("Usage: node src/route-dual.js [durationSec] [options]");
  console.log("\nOptions:");
  console.log("  --device1 <nameOrId>   Target playback device 1 (name substring or runtime ID)");
  console.log("  --device2 <nameOrId>   Target playback device 2 (name substring or runtime ID)");
  console.log("  --vol1 <0.0-1.0>       Software volume for Device 1 (default: 1.0 = unity gain)");
  console.log("  --vol2 <0.0-1.0>       Software volume for Device 2 (default: 1.0 = unity gain)");
  console.log("  --allow-conflict       Bypass default-output conflict warning prompt");
  console.log("  --no-mute              Disable automatic default endpoint muting (speakers remain audible)");
  console.log("  -h, --help             Show this help message");
  console.log("\nDefaults:");
  console.log("  Device 1: realme Buds T310 (preferred substring: 'realme')");
  console.log("  Device 2: Airdopes 161 (preferred substring: 'airdopes')");
  console.log("  Volume 1: 1.0 (100% unity gain)");
  console.log("  Volume 2: 1.0 (100% unity gain)");
  console.log("  Duration: Unlimited (runs until Ctrl+C)");
  console.log("  Mute    : Active (default render endpoint automatically muted during routing)");
}

function formatDb(db) {
  if (!isFinite(db) || db <= -96.0) {
    return "-inf dBFS";
  }
  return `${db.toFixed(1)} dBFS`;
}

function createMeter(db, width = 10) {
  if (!isFinite(db) || db <= -60) {
    return "[" + "-".repeat(width) + "]";
  }
  const minDb = -60;
  const clampedDb = Math.max(minDb, Math.min(0, db));
  const fraction = (clampedDb - minDb) / (0 - minDb);
  const filled = Math.round(fraction * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

/**
 * Discovers all active Windows playback endpoints and queries the default output ID.
 */
function discoverEndpoints() {
  let rt;
  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    console.error("[FATAL] Could not initialize RtAudio discovery backend:", err.message);
    process.exit(1);
  }

  const allDevices = rt.getDevices();
  const playbackDevices = allDevices.filter((d) => d && d.outputChannels > 0);
  let defaultOutputId = -1;
  try {
    defaultOutputId = rt.getDefaultOutputDevice();
  } catch (err) {
    console.warn("[WARNING] Could not query default output device ID:", err.message);
  }

  return { playbackDevices, defaultOutputId };
}

/**
 * Resolves a device query (numeric ID or case-insensitive name substring)
 * against active playback endpoints.
 */
function resolveDevice(playbackDevices, query, fallbackPattern, excludeDeviceId = -1) {
  // 1. If explicit query provided
  if (query) {
    const numericId = parseInt(query, 10);
    if (!isNaN(numericId)) {
      const matchById = playbackDevices.find((d) => d.id === numericId);
      if (matchById) return matchById;
    }
    const lower = query.toLowerCase();
    const matchByName = playbackDevices.find((d) => (d.name || "").toLowerCase().includes(lower) && d.id !== excludeDeviceId);
    if (matchByName) return matchByName;
    return null;
  }

  // 2. If fallback pattern provided
  if (fallbackPattern) {
    const lowerPattern = fallbackPattern.toLowerCase();
    const match = playbackDevices.find((d) => (d.name || "").toLowerCase().includes(lowerPattern) && d.id !== excludeDeviceId);
    if (match) return match;
  }

  return null;
}

// Global Endpoint Mute Manager
const endpointMute = new EndpointMuteManager({ enabled: !noMute });

// Emergency process-level termination hooks for unexpected runtime errors
process.on("uncaughtException", (err) => {
  console.error("\n[FATAL UNCAUGHT EXCEPTION]:", err.message);
  endpointMute.restoreSync();
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("\n[FATAL UNHANDLED REJECTION]:", err?.message || err);
  endpointMute.restoreSync();
  process.exit(1);
});

async function runDualRouter() {
  console.log("=================================================");
  console.log(" DuoAudio - Phase 4C: Dual-Output Audio Router   ");
  console.log(" Backend : Windows WASAPI Shared-Mode Loopback   ");
  console.log(" Capture : loopback-capture@4.0.0 (PID-Excluded) ");
  console.log(" Outputs : audify@1.10.1 (2x Independent Streams)");
  console.log(" Mute    : Windows Core Audio COM Endpoint Mute  ");
  console.log("=================================================\n");

  // Step 1: Discover active Windows playback endpoints
  console.log("Step 1: Enumerating active Windows playback endpoints...");
  const { playbackDevices, defaultOutputId } = discoverEndpoints();
  console.log(`  Found ${playbackDevices.length} active playback endpoint(s):`);
  for (const d of playbackDevices) {
    const isDefault = d.id === defaultOutputId || d.isDefaultOutput ? " [DEFAULT OUTPUT]" : "";
    console.log(`    - [#${d.id}] "${d.name}" (${d.outputChannels} ch, ${d.preferredSampleRate} Hz)${isDefault}`);
  }

  if (playbackDevices.length === 0) {
    console.error("\n[FATAL] No active playback endpoints found on the system.");
    process.exit(1);
  }

  // Step 2: Select Device 1 and Device 2
  console.log("\nStep 2: Resolving target dual playback endpoints...");

  const dev1 = resolveDevice(playbackDevices, device1Filter, "realme");
  const dev2 = resolveDevice(playbackDevices, device2Filter, "airdopes", dev1 ? dev1.id : -1);

  if (!dev1 || !dev2) {
    console.error("\n[FATAL] Could not resolve both target playback endpoints.");
    if (!dev1) {
      console.error(`  - Destination 1 not found: ${device1Filter ? `query "${device1Filter}"` : "default 'realme' (realme Buds T310)"}`);
    }
    if (!dev2) {
      console.error(`  - Destination 2 not found: ${device2Filter ? `query "${device2Filter}"` : "default 'airdopes' (Airdopes 161)"}`);
    }
    console.error("\nAvailable options:");
    console.error("  1. Ensure both Bluetooth earbuds are powered on and connected.");
    console.error("  2. Specify endpoints explicitly using: --device1 <idOrName> --device2 <idOrName>\n");
    process.exit(1);
  }

  if (dev1.id === dev2.id) {
    console.error(`\n[FATAL] Destination 1 and Destination 2 cannot be the same device (Both selected: [#${dev1.id}] "${dev1.name}").`);
    process.exit(1);
  }

  console.log(`  >>> Output 1 Destination : [#${dev1.id}] "${dev1.name}"`);
  console.log(`  >>> Output 2 Destination : [#${dev2.id}] "${dev2.name}"\n`);

  // Step 3: Default-Output Conflict Detection
  const hasConflictDev1 = dev1.id === defaultOutputId || dev1.isDefaultOutput;
  const hasConflictDev2 = dev2.id === defaultOutputId || dev2.isDefaultOutput;

  if (hasConflictDev1 || hasConflictDev2) {
    const conflicting = hasConflictDev1 ? dev1 : dev2;
    console.log("======================================================================");
    console.log(" [WARNING: DEFAULT OUTPUT CONFLICT DETECTED]");
    console.log(` Destination device "${conflicting.name}" (ID: ${conflicting.id})`);
    console.log(" is currently configured as the active Windows Default Playback Endpoint.");
    console.log("");
    console.log(" EXPLANATION:");
    console.log(" Windows directly routes audio from applications to the default endpoint.");
    console.log(" Routing captured loopback audio back into the default endpoint causes");
    console.log(" duplicate audio playback (echo) with an offset of ~50 ms.");
    console.log("");
    console.log(" RECOMMENDED ACTION:");
    console.log(" 1. Open Windows Sound Settings (ms-settings:sound).");
    console.log(" 2. Set your built-in PC speakers (e.g., 'Speaker (Realtek(R) Audio)')");
    console.log("    as the Windows Default Output device.");
    console.log(" 3. Re-run DuoAudio. Loopback capture will tap the system audio mix,");
    console.log("    and both earbuds will reproduce clean, duplicate-free audio.");
    console.log("======================================================================\n");

    if (!allowConflict) {
      console.log("  [NOTICE] Continuing with conflict warning logged. Use --allow-conflict to suppress this notice.\n");
    }
  } else {
    console.log("Step 3: Pre-flight default-output conflict check passed.");
    console.log(`  Windows Default Output is Device ID: ${defaultOutputId} (Neither destination conflicts).\n`);
  }

  // Step 4: Automatic Default Render Endpoint Mute Management (Phase 4C.1)
  console.log("Step 4: Managing Windows default playback endpoint mute state...");
  try {
    await endpointMute.initAndMute();
  } catch (err) {
    console.error("\n[FATAL] Default endpoint mute management failed:", err.message);
    console.error("Aborting startup safely to prevent uncoordinated audio playback.\n");
    process.exit(1);
  }

  // Step 5: Display pipeline configuration
  console.log("Pipeline Specifications:");
  console.log(`  Sample Rate            : ${SAMPLE_RATE} Hz`);
  console.log(`  Channels               : ${CHANNELS} (stereo)`);
  console.log(`  Capture Format         : Signed 16-bit PCM (S16LE, 10 ms buffers)`);
  console.log(`  Converter Output       : 32-bit Float PCM (Float32LE, 20 ms / 7,680 bytes)`);
  console.log(`  Software Output Volume : Output 1 = ${Math.round(vol1 * 100)}% (${vol1 === 1.0 ? "1.00 unity" : vol1.toFixed(2)}), Output 2 = ${Math.round(vol2 * 100)}% (${vol2 === 1.0 ? "1.00 unity" : vol2.toFixed(2)})`);
  console.log(`  Per-Output Queue Cap   : 200 ms (10 buffers of 20 ms, drop-oldest)`);
  console.log(`  Per-Output Prebuffer   : 80 ms (4 buffers of 20 ms before playback start)`);
  console.log(`  Rate Pacer             : 10 ms interval, wall-clock estimated lead <= 40 ms`);
  console.log(`  Failure Isolation      : Active (failure of one output does not halt the other)`);
  console.log(`  Endpoint Mute State    : ${endpointMute.isMutedByDuoAudio ? "MUTED by DuoAudio" : (endpointMute.originallyMuted ? "Originally MUTED" : "UNMUTED (--no-mute)")}`);
  if (vol1 === 1.0 || vol2 === 1.0) {
    console.log("  [NOTICE] Output operating at unity gain (0 dBFS). Audio level is now ~24 dB louder than");
    console.log("           previous 20% builds. Set Windows master volume to a low, comfortable level first.\n");
  } else {
    console.log("");
  }

  // Step 6: Initialize Subsystems
  const converter = new PcmConverter({
    inputSampleRate: SAMPLE_RATE,
    outputSampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frameDurationMs: 20
  });

  const capture = new loopback.LoopbackCapture();

  // Failure isolation handler: Surviving stream continues, speaker remains muted!
  function handleStreamError(err, failedStream) {
    const survivingStream = failedStream === stream1 ? stream2 : stream1;
    console.error(`\n[ISOLATION ALERT] ${failedStream.name} ("${failedStream.device?.name}") halted due to error: ${err.message}`);

    if (survivingStream.isActive) {
      console.log(`[ISOLATION CONFIRMED] Surviving ${survivingStream.name} ("${survivingStream.device?.name}") continues playing uninterrupted.`);
      if (endpointMute.targetEndpoint) {
        console.log(`[MUTE] Default endpoint ("${endpointMute.targetEndpoint.name}") remains MUTED while surviving output plays.\n`);
      }
    } else {
      console.error("[FATAL] All destination output streams have halted. Initiating router shutdown...\n");
      shutdown("All destination streams halted");
    }
  }

  const stream1 = new OutputStream({
    name: "Output 1",
    volume: vol1,
    maxCapacityMs: 200,
    targetPrebufferMs: 80,
    onError: handleStreamError
  });

  const stream2 = new OutputStream({
    name: "Output 2",
    volume: vol2,
    maxCapacityMs: 200,
    targetPrebufferMs: 80,
    onError: handleStreamError
  });

  console.log("Step 5: Opening destination WASAPI output streams...");
  try {
    stream1.open(dev1);
    console.log(`  [+] Output 1 opened on [#${dev1.id}] "${dev1.name}" (State: PREBUFFERING)`);
  } catch (err) {
    console.error(`  [-] Failed to open Output 1 on "${dev1.name}":`, err.message);
    await endpointMute.restore();
    process.exit(1);
  }

  try {
    stream2.open(dev2);
    console.log(`  [+] Output 2 opened on [#${dev2.id}] "${dev2.name}" (State: PREBUFFERING)\n`);
  } catch (err) {
    console.error(`  [-] Failed to open Output 2 on "${dev2.name}":`, err.message);
    stream1.close();
    await endpointMute.restore();
    process.exit(1);
  }

  // Telemetry state
  let totalCaptureCallbacks = 0;
  let totalCaptureBytes = 0;
  let cumulativeSamples = 0;
  let cumulativeNonZeroSamples = 0;
  let cumulativePeak = 0.0;
  let cumulativeSumSquares = 0.0;

  // 1-second rolling metrics
  let windowCallbacks = 0;
  let windowBytes = 0;
  let windowPeak = 0.0;
  let windowSumSquares = 0.0;
  let windowSamples = 0;

  const startTime = Date.now();
  let isShuttingDown = false;

  // Shared Capture Ingestion & Fan-Out Callback
  function onCaptureChunk(chunk) {
    if (isShuttingDown) return;

    totalCaptureCallbacks++;
    totalCaptureBytes += chunk.length;
    windowCallbacks++;
    windowBytes += chunk.length;

    // Fast diagnostic pass on raw 16-bit PCM
    const sampleCount = chunk.length / 2;
    for (let offset = 0; offset < chunk.length; offset += 2) {
      const sample = chunk.readInt16LE(offset);
      const normalized = Math.abs(sample) / 32768.0;

      cumulativeSamples++;
      windowSamples++;

      if (sample !== 0) {
        cumulativeNonZeroSamples++;
      }

      if (normalized > cumulativePeak) cumulativePeak = normalized;
      if (normalized > windowPeak) windowPeak = normalized;

      const sq = normalized * normalized;
      cumulativeSumSquares += sq;
      windowSumSquares += sq;
    }

    // Convert S16LE chunks into standard 20 ms Float32 output frames
    const outputFrames = converter.processChunk(chunk);

    // Fan-out: referentially share the converted Float32 Buffer across both streams
    for (let i = 0; i < outputFrames.length; i++) {
      const frame = outputFrames[i];
      if (stream1.isActive) stream1.enqueue(frame);
      if (stream2.isActive) stream2.enqueue(frame);
    }
  }

  // Coordinated Shutdown Handler
  async function shutdown(reason) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n\nInitiating coordinated router shutdown (${reason})...`);

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

    // 2. Stop both output streams
    try {
      console.log(`  Closing Output 1 on "${dev1.name}"...`);
      stream1.close();
      console.log("  Output 1 closed cleanly.");
    } catch (err) {
      console.error("  Error closing Output 1:", err.message);
    }

    try {
      console.log(`  Closing Output 2 on "${dev2.name}"...`);
      stream2.close();
      console.log("  Output 2 closed cleanly.");
    } catch (err) {
      console.error("  Error closing Output 2:", err.message);
    }

    // 3. Restore default playback endpoint mute state
    try {
      await endpointMute.restore();
    } catch (err) {
      console.error("  Error restoring default endpoint mute state:", err.message);
    }

    // 4. Print Comprehensive Dual-Output Routing Final Report
    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const audioCapturedSec = (totalCaptureBytes / (SAMPLE_RATE * 4)).toFixed(2);
    const overallRms = cumulativeSamples > 0 ? Math.sqrt(cumulativeSumSquares / cumulativeSamples) : 0;
    const overallDb = overallRms > 0 ? 20 * Math.log10(overallRms) : -Infinity;

    const diag1 = stream1.getDiagnostics();
    const diag2 = stream2.getDiagnostics();

    console.log("\n=================================================");
    console.log(" Phase 4C: Dual-Output Audio Routing Final Report");
    console.log("=================================================");
    console.log(`  Wall-Clock Duration     : ${totalElapsedSec} seconds`);
    console.log(`  PID Exclusion           : ${process.pid} (Excluded from loopback)`);
    console.log(`  Capture Callbacks       : ${totalCaptureCallbacks}`);
    console.log(`  Capture Bytes Received  : ${totalCaptureBytes} bytes (${(totalCaptureBytes / 1024).toFixed(1)} KB)`);
    console.log(`  Audio Captured Equiv    : ${audioCapturedSec} seconds`);
    console.log(`  Non-Zero Samples        : ${cumulativeNonZeroSamples} (${cumulativeSamples > 0 ? ((cumulativeNonZeroSamples / cumulativeSamples) * 100).toFixed(2) : "0.00"}%)`);
    console.log(`  Captured Peak Amplitude : ${cumulativePeak.toFixed(4)} (${(cumulativePeak * 100).toFixed(1)}% of full scale)`);
    console.log(`  Captured Overall RMS    : ${formatDb(overallDb)}`);
    console.log(`  Default Mute Management : ${endpointMute.enabled ? (endpointMute.originallyMuted ? "Preserved Pre-Muted State" : "Restored Original Unmuted State") : "Disabled (--no-mute)"}`);
    console.log("-------------------------------------------------");
    console.log(`  Output 1 ("${diag1.deviceName}", ID: ${diag1.deviceId}):`);
    console.log(`    State                 : ${diag1.state}`);
    console.log(`    Buffers Written       : ${diag1.submittedFrames} (${diag1.audioSecondsPlayed}s audio played)`);
    console.log(`    Buffer Drops (Drop-Old): ${diag1.queue.droppedBuffers}`);
    console.log(`    Underrun Ticks        : ${diag1.underrunTicks}`);
    console.log(`    Final Queue Depth     : ${diag1.queue.queuedMs} ms (${diag1.queue.queuedBuffers} buf)`);
    console.log("-------------------------------------------------");
    console.log(`  Output 2 ("${diag2.deviceName}", ID: ${diag2.deviceId}):`);
    console.log(`    State                 : ${diag2.state}`);
    console.log(`    Buffers Written       : ${diag2.submittedFrames} (${diag2.audioSecondsPlayed}s audio played)`);
    console.log(`    Buffer Drops (Drop-Old): ${diag2.queue.droppedBuffers}`);
    console.log(`    Underrun Ticks        : ${diag2.underrunTicks}`);
    console.log(`    Final Queue Depth     : ${diag2.queue.queuedMs} ms (${diag2.queue.queuedBuffers} buf)`);
    console.log("=================================================\n");

    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT (Ctrl+C)");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  // Step 7: Start System Audio Capture with PID Exclusion
  console.log(`Step 6: Starting WASAPI loopback capture with PID exclusion (Excluding PID: ${process.pid})...`);
  try {
    capture.startSystemAudio(onCaptureChunk, process.pid);
    console.log("  Capture running with process exclusion active.");
    console.log("  >>> Dual routing active! Play system audio (YouTube, VLC, etc.) to listen. <<<\n");
  } catch (err) {
    console.error("[FATAL] Failed to start system audio capture:", err.message);
    stream1.close();
    stream2.close();
    await endpointMute.restore();
    process.exit(1);
  }

  // Periodic 1-second Dual Telemetry Dashboard
  const statsTimer = setInterval(() => {
    if (isShuttingDown) return;

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const windowRms = windowSamples > 0 ? Math.sqrt(windowSumSquares / windowSamples) : 0;
    const windowDb = windowRms > 0 ? 20 * Math.log10(windowRms) : -Infinity;
    const meter = createMeter(windowDb, 8);

    const d1 = stream1.getDiagnostics();
    const d2 = stream2.getDiagnostics();

    const shortName1 = d1.deviceName.replace(/^Headphones \((.*?)\)$/, "$1").substring(0, 12);
    const shortName2 = d2.deviceName.replace(/^Headphones \((.*?)\)$/, "$1").substring(0, 12);

    if (windowCallbacks === 0) {
      console.log(
        `[${elapsedSec.padStart(3)}s] Silence Gate | ` +
        `Out1 (${shortName1}): ${d1.state.padEnd(7)} (Q: ${d1.queue.queuedMs}ms) | ` +
        `Out2 (${shortName2}): ${d2.state.padEnd(7)} (Q: ${d2.queue.queuedMs}ms)`
      );
    } else {
      console.log(
        `[${elapsedSec.padStart(3)}s] ${meter} ${formatDb(windowDb).padEnd(11)} | ` +
        `Out1 (${shortName1}): ${d1.state.padEnd(7)} Q:${d1.queue.queuedMs.toString().padStart(3)}ms Sub:${d1.submittedFrames.toString().padStart(4)} Drp:${d1.queue.droppedBuffers} Und:${d1.underrunTicks} | ` +
        `Out2 (${shortName2}): ${d2.state.padEnd(7)} Q:${d2.queue.queuedMs.toString().padStart(3)}ms Sub:${d2.submittedFrames.toString().padStart(4)} Drp:${d2.queue.droppedBuffers} Und:${d2.underrunTicks}`
      );
    }

    // Reset window metrics
    windowCallbacks = 0;
    windowBytes = 0;
    windowPeak = 0.0;
    windowSumSquares = 0.0;
    windowSamples = 0;
  }, 1000);

  // Optional Duration Timer
  let durationTimer = null;
  if (durationSec) {
    durationTimer = setTimeout(() => {
      shutdown(`Configured duration of ${durationSec}s reached`);
    }, durationSec * 1000);
  }
}

runDualRouter().catch((err) => {
  console.error("[FATAL in runDualRouter]:", err.message);
  endpointMute.restoreSync();
  process.exit(1);
});
