/**
 * DuoAudio - Phase 3B: Windows System Audio Capture Test Harness
 *
 * Captures Windows system audio from the default render endpoint via WASAPI loopback
 * using loopback-capture@4.0.0. Inspects incoming 16-bit stereo PCM buffers, validates
 * payload structure, and calculates peak, RMS, and dBFS signal statistics.
 */

const loopback = require("loopback-capture");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // Signed 16-bit integer = 2 bytes
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per stereo frame
const FULL_SCALE_INT16 = 32768.0;

// Parse optional duration argument (in seconds). If omitted, runs continuously until Ctrl+C.
const argDuration = parseInt(process.argv[2], 10);
const maxDurationSec = !isNaN(argDuration) && argDuration > 0 ? argDuration : null;

function formatDb(db) {
  if (!isFinite(db) || db <= -96.0) {
    return "-inf dBFS (silence)";
  }
  return `${db.toFixed(1)} dBFS`;
}

function createMeter(db, width = 16) {
  if (!isFinite(db) || db <= -60) {
    return "[" + "-".repeat(width) + "]";
  }
  const minDb = -60;
  const clampedDb = Math.max(minDb, Math.min(0, db));
  const fraction = (clampedDb - minDb) / (0 - minDb);
  const filled = Math.round(fraction * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function runSystemCapture() {
  console.log("=================================================");
  console.log(" DuoAudio - Phase 3B: System Audio Capture       ");
  console.log(" Backend: Windows WASAPI Shared-Mode Loopback    ");
  console.log(" Package: loopback-capture@4.0.0                 ");
  console.log("=================================================\n");

  console.log("Stream Specification (WASAPI Default Render Loopback):");
  console.log(`  Sample Rate         : ${SAMPLE_RATE} Hz`);
  console.log(`  Channels            : ${CHANNELS} (interleaved stereo)`);
  console.log(`  Format              : Signed 16-bit PCM (little-endian)`);
  console.log(`  Frame Size (bytes)  : ${BYTES_PER_FRAME} bytes per stereo frame`);
  console.log(`  Execution Mode      : ${maxDurationSec ? `Fixed duration (${maxDurationSec}s)` : "Continuous (Press Ctrl+C to stop)"}`);
  console.log();
  console.log("Important Native Driver Behavior:");
  console.log("  WASAPI loopback captures audio rendered by applications through the default playback endpoint.");
  console.log("  Buffers below approximately -70 dBFS are suppressed by the native silence gate.");
  console.log("  >>> Please play audio (e.g. YouTube in a browser, or media in VLC) to observe live capture. <<<\n");

  let capture;
  try {
    capture = new loopback.LoopbackCapture();
  } catch (err) {
    console.error("[FATAL] Failed to instantiate LoopbackCapture:", err.message);
    process.exit(1);
  }

  // Cumulative Metrics
  let totalBuffers = 0;
  let totalBytes = 0;
  let smallestBufferBytes = Infinity;
  let largestBufferBytes = 0;
  let cumulativePeak = 0;
  let cumulativeSumSquares = 0;
  let cumulativeSamples = 0;
  let cumulativeNonZeroSamples = 0;
  const startTime = Date.now();

  // Periodic Window Metrics (reset every 1 second)
  let windowBuffers = 0;
  let windowBytes = 0;
  let windowPeak = 0;
  let windowSumSquares = 0;
  let windowSamples = 0;
  let windowNonZeroSamples = 0;

  let isStopping = false;
  let inspectedChunksCount = 0;
  const MAX_INSPECTED_CHUNKS = 3;

  function onAudioChunk(chunk) {
    if (isStopping) return;

    try {
      // 1. Validate chunk structure
      if (!Buffer.isBuffer(chunk)) {
        console.error("\n[ERROR] Received non-Buffer object from native loopback capture!");
        return;
      }

      if (chunk.length % BYTES_PER_FRAME !== 0) {
        console.warn(`\n[WARNING] Chunk size (${chunk.length} bytes) is not aligned to ${BYTES_PER_FRAME}-byte stereo frame.`);
      }

      const chunkBytes = chunk.length;
      totalBuffers++;
      totalBytes += chunkBytes;
      windowBuffers++;
      windowBytes += chunkBytes;

      if (chunkBytes < smallestBufferBytes) smallestBufferBytes = chunkBytes;
      if (chunkBytes > largestBufferBytes) largestBufferBytes = chunkBytes;

      // 2. Process signed 16-bit PCM samples
      const sampleCount = chunkBytes / BYTES_PER_SAMPLE;
      cumulativeSamples += sampleCount;
      windowSamples += sampleCount;

      let chunkMin = 32767;
      let chunkMax = -32768;
      let chunkNonZero = 0;
      let chunkPeak = 0;
      let chunkSumSquares = 0;

      for (let i = 0; i < chunkBytes; i += BYTES_PER_SAMPLE) {
        const rawSample = chunk.readInt16LE(i);
        if (rawSample < chunkMin) chunkMin = rawSample;
        if (rawSample > chunkMax) chunkMax = rawSample;
        if (rawSample !== 0) {
          chunkNonZero++;
          cumulativeNonZeroSamples++;
          windowNonZeroSamples++;
        }

        // Normalized to [-1.0, 1.0]
        const normalized = rawSample / FULL_SCALE_INT16;
        const absSample = Math.abs(normalized);

        if (absSample > chunkPeak) chunkPeak = absSample;
        if (absSample > cumulativePeak) cumulativePeak = absSample;
        if (absSample > windowPeak) windowPeak = absSample;

        const sq = normalized * normalized;
        chunkSumSquares += sq;
        cumulativeSumSquares += sq;
        windowSumSquares += sq;
      }

      // 3. Inspect first few raw buffers for diagnostics
      if (inspectedChunksCount < MAX_INSPECTED_CHUNKS) {
        inspectedChunksCount++;
        const hexPreview = chunk.subarray(0, Math.min(32, chunkBytes)).toString("hex");
        const chunkRms = sampleCount > 0 ? Math.sqrt(chunkSumSquares / sampleCount) : 0;
        const chunkDb = chunkRms > 0 ? 20 * Math.log10(chunkRms) : -Infinity;
        console.log(`\n--- [RAW BUFFER INSPECTION #${inspectedChunksCount}] ---`);
        console.log(`  Buffer size       : ${chunkBytes} bytes (${sampleCount} samples, ${sampleCount / CHANNELS} stereo frames)`);
        console.log(`  First 32 bytes hex: ${hexPreview}`);
        console.log(`  Sample value range: [${chunkMin}, ${chunkMax}] (int16 scale: -32768 to 32767)`);
        console.log(`  Non-zero samples  : ${chunkNonZero} / ${sampleCount} (${((chunkNonZero / sampleCount) * 100).toFixed(1)}%)`);
        console.log(`  Buffer Peak       : ${chunkPeak.toFixed(4)} (${(chunkPeak * 100).toFixed(2)}%)`);
        console.log(`  Buffer RMS        : ${formatDb(chunkDb)}`);
        console.log(`  Is All Zeros      : ${chunkNonZero === 0 ? "YES (Digital Silence)" : "NO (Contains Signal)"}`);
        console.log("----------------------------------------\n");
      }
    } catch (err) {
      console.error("\n[EXCEPTION in onAudioChunk callback]:", err.stack || err.message);
    }
  }

  function stopCapture() {
    if (isStopping) return;
    isStopping = true;

    if (statsTimer) {
      clearInterval(statsTimer);
    }
    if (durationTimer) {
      clearTimeout(durationTimer);
    }

    console.log("\n\nStopping WASAPI loopback capture...");
    try {
      capture.stop();
      console.log("Native capture stopped successfully.");
    } catch (err) {
      console.error("Error stopping capture:", err.message);
    }

    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const audioSecondsEquivalent = (totalBytes / (SAMPLE_RATE * BYTES_PER_FRAME)).toFixed(2);
    const overallRms = cumulativeSamples > 0 ? Math.sqrt(cumulativeSumSquares / cumulativeSamples) : 0;
    const overallDb = overallRms > 0 ? 20 * Math.log10(overallRms) : -Infinity;

    let captureStatus;
    if (totalBuffers === 0) {
      captureStatus = "NO BUFFERS RECEIVED (Silence gate suppressed all data or device inactive)";
    } else if (cumulativeNonZeroSamples === 0) {
      captureStatus = "BUFFERS RECEIVED BUT PURE DIGITAL SILENCE (All captured samples were 0)";
    } else {
      captureStatus = `SUCCESS (Active non-zero audio captured: ${(cumulativePeak * 100).toFixed(1)}% peak, ${cumulativeNonZeroSamples} non-zero samples)`;
    }

    console.log("\n=================================================");
    console.log(" Phase 3B: System Audio Capture Final Report     ");
    console.log("=================================================");
    console.log(`  Wall-Clock Duration : ${totalElapsedSec} seconds`);
    console.log(`  Total Buffers       : ${totalBuffers}`);
    console.log(`  Total Bytes         : ${totalBytes} bytes (${(totalBytes / 1024).toFixed(1)} KB)`);
    console.log(`  Smallest Buffer     : ${totalBuffers > 0 ? smallestBufferBytes + " bytes" : "N/A"}`);
    console.log(`  Largest Buffer      : ${totalBuffers > 0 ? largestBufferBytes + " bytes" : "N/A"}`);
    console.log(`  Audio Equivalent    : ${audioSecondsEquivalent} seconds`);
    console.log(`  Total Samples       : ${cumulativeSamples}`);
    console.log(`  Non-Zero Samples    : ${cumulativeNonZeroSamples} (${cumulativeSamples > 0 ? ((cumulativeNonZeroSamples / cumulativeSamples) * 100).toFixed(2) : "0.00"}%)`);
    console.log(`  Peak Amplitude      : ${cumulativePeak.toFixed(4)} (${(cumulativePeak * 100).toFixed(1)}% of full scale)`);
    console.log(`  Overall RMS Level   : ${formatDb(overallDb)}`);
    console.log(`  Capture Status      : ${captureStatus}`);
    console.log("=================================================\n");

    process.exit(0);
  }

  process.on("SIGINT", () => {
    console.log("\n[INTERRUPT] Received SIGINT (Ctrl+C). Initiating clean shutdown...");
    stopCapture();
  });

  // Start capture
  try {
    console.log("Starting capture on Windows default playback endpoint...");
    capture.startSystemAudio(onAudioChunk);
    console.log("Capture running! Listening for system audio...\n");
  } catch (err) {
    console.error("[FATAL] Failed to start system audio capture:", err.message);
    process.exit(1);
  }

  // Periodic diagnostic logger (once per second)
  let secondCounter = 0;
  const statsTimer = setInterval(() => {
    if (isStopping) return;
    secondCounter++;
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);

    if (windowBuffers === 0) {
      console.log(`[${elapsedSec}s] Waiting for audio... (No buffers received. Play sound in an application to generate stream data)`);
    } else {
      const windowRms = windowSamples > 0 ? Math.sqrt(windowSumSquares / windowSamples) : 0;
      const windowDb = windowRms > 0 ? 20 * Math.log10(windowRms) : -Infinity;
      const meter = createMeter(windowDb, 16);
      const kbWindow = (windowBytes / 1024).toFixed(1);

      console.log(
        `[${elapsedSec}s] ${meter} ${formatDb(windowDb).padEnd(18)} | ` +
        `Peak: ${(windowPeak * 100).toFixed(1)}% | ` +
        `Sec: ${windowBuffers.toString().padStart(3)} buf (${kbWindow.padStart(5)} KB) | ` +
        `Non-Zero: ${windowNonZeroSamples}/${windowSamples} | ` +
        `Total: ${totalBuffers} buf (${(totalBytes / 1024).toFixed(1)} KB)`
      );
    }

    // Reset window metrics
    windowBuffers = 0;
    windowBytes = 0;
    windowPeak = 0;
    windowSumSquares = 0;
    windowSamples = 0;
    windowNonZeroSamples = 0;
  }, 1000);

  // Optional duration timer
  let durationTimer = null;
  if (maxDurationSec) {
    durationTimer = setTimeout(() => {
      console.log(`\nConfigured duration of ${maxDurationSec} seconds reached.`);
      stopCapture();
    }, maxDurationSec * 1000);
  }
}

runSystemCapture();
