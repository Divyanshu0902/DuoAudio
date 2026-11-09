/**
 * DuoAudio - Dedicated Audio Child Process Runner (Phase 5C.2)
 *
 * Runs exclusively in the genuine system Node.js runtime (node.exe) as an isolated
 * child process managed by Electron's AudioService.
 *
 * Responsibilities:
 * 1. Executes the dual-output WASAPI audio routing pipeline (loopback-capture + audify).
 * 2. Employs process-tree loopback exclusion using process.pid to prevent echo.
 * 3. Communicates with Electron Main Process via structured JSON IPC messages.
 * 4. Discovers and reports default endpoint mute baseline BEFORE muting.
 * 5. Safely restores default endpoint mute state upon shutdown or process exit.
 * 6. Implements stream failure isolation (PARTIALLY_DEGRADED state).
 * 7. Automatically tears down and restores mute if parent process disconnects (process.on('disconnect')).
 */

const loopback = require('loopback-capture');
const { RtAudio, RtAudioApi } = require('audify');
const { PcmConverter, SAMPLE_RATE, CHANNELS } = require('./pcm_converter');
const { OutputStream } = require('./output_stream');
const { EndpointMuteManager } = require('./endpoint_mute');

// State tracking
let runnerState = 'IDLE'; // IDLE, STARTING, PREBUFFERING, RUNNING, PARTIALLY_DEGRADED, STOPPING, STOPPED, ERROR
let isShuttingDown = false;
let capture = null;
let stream1 = null;
let stream2 = null;
let endpointMute = null;
let metricsTimer = null;
let durationTimer = null;

// Metrics accumulator
let windowSamples = 0;
let windowSumSquares = 0.0;
let windowPeak = 0.0;

function sendIpcMessage(msg) {
  if (typeof process.send === 'function' && process.connected) {
    try {
      process.send(msg);
    } catch (err) {
      // Channel may have been closed
    }
  }
}

function updateState(newState, details = null) {
  runnerState = newState;
  sendIpcMessage({
    type: 'STATE_CHANGE',
    state: newState,
    details: details || undefined
  });
}

/**
 * Discovers active Windows playback endpoints and default output ID.
 */
function discoverEndpoints() {
  let rt;
  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    throw new Error(`Failed to initialize RtAudio discovery backend: ${err.message}`);
  }

  const allDevices = rt.getDevices();
  const playbackDevices = allDevices.filter((d) => d && d.outputChannels > 0);
  let defaultOutputId = -1;
  try {
    defaultOutputId = rt.getDefaultOutputDevice();
  } catch (err) {
    // Default output query non-fatal
  }

  return { playbackDevices, defaultOutputId };
}

/**
 * Awaits MUTE_BASELINE_ACK message from the main process.
 * @param {string} expectedEndpointId
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<boolean>}
 */
function waitForMuteBaselineAck(expectedEndpointId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let timer;
    const messageHandler = (msg) => {
      if (msg && msg.type === 'MUTE_BASELINE_ACK') {
        if (!expectedEndpointId || msg.endpointId === expectedEndpointId) {
          cleanup();
          resolve(true);
        }
      }
    };

    const disconnectHandler = () => {
      cleanup();
      resolve(false);
    };

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('message', messageHandler);
      process.removeListener('disconnect', disconnectHandler);
    }

    timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    process.on('message', messageHandler);
    process.on('disconnect', disconnectHandler);
  });
}

/**
 * Initiates graceful shutdown and resource cleanup.
 * @param {string} reason
 */
async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  updateState('STOPPING', { reason });

  if (metricsTimer) clearInterval(metricsTimer);
  if (durationTimer) clearTimeout(durationTimer);

  // 1. Stop capture
  try {
    if (capture) {
      capture.stop();
      capture = null;
    }
  } catch (err) {
    console.error('[RUNNER] Error stopping capture:', err.message);
  }

  // 2. Close output streams
  try {
    if (stream1) {
      stream1.close();
      stream1 = null;
    }
  } catch (err) {
    console.error('[RUNNER] Error closing Output 1:', err.message);
  }

  try {
    if (stream2) {
      stream2.close();
      stream2 = null;
    }
  } catch (err) {
    console.error('[RUNNER] Error closing Output 2:', err.message);
  }

  // 3. Audio capture & streams are closed; emit STOPPED
  updateState('STOPPED', { reason });
  sendIpcMessage({ type: 'STOPPED' });

  // 4. Restore default playback endpoint mute state
  let restorationResult = { restored: false, status: 'NOT_REQUIRED' };
  if (endpointMute) {
    try {
      restorationResult = await endpointMute.restore();
    } catch (err) {
      restorationResult = { restored: false, status: 'FAILED', error: err.message };
    }
  }

  // 5. Send structured RESTORATION_RESULT to parent
  sendIpcMessage({
    type: 'MUTE_RESTORATION_RESULT',
    status: restorationResult.status || (restorationResult.restored ? 'RESTORED' : 'FAILED'),
    endpointId: endpointMute?.targetEndpoint?.id || null,
    error: restorationResult.error || null
  });

  // Clean exit code reflects restoration result
  const exitCode = (restorationResult.status === 'FAILED') ? 1 : 0;
  setTimeout(() => {
    process.exit(exitCode);
  }, 50);
}

/**
 * Starts the dual-output audio router pipeline.
 * @param {Object} config
 * @param {number} config.device1Id
 * @param {number} config.device2Id
 * @param {number} [config.vol1=1.0]
 * @param {number} [config.vol2=1.0]
 * @param {boolean} [config.noMute=false]
 * @param {number} [config.durationSec=null]
 */
async function startDualRouter(config) {
  if (runnerState !== 'IDLE') {
    throw new Error(`Cannot start audio runner: current state is "${runnerState}".`);
  }

  updateState('STARTING');

  const { device1Id, device2Id, noMute = false, durationSec = null } = config;
  const vol1 = typeof config.vol1 === 'number' ? Math.max(0, Math.min(1, config.vol1)) : 1.0;
  const vol2 = typeof config.vol2 === 'number' ? Math.max(0, Math.min(1, config.vol2)) : 1.0;

  // 1. Validate device identifiers
  if (typeof device1Id !== 'number' || typeof device2Id !== 'number') {
    const err = new Error(`Invalid device IDs provided: device1Id=${device1Id}, device2Id=${device2Id}`);
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  if (device1Id === device2Id) {
    const err = new Error(`Device 1 and Device 2 cannot be identical (ID: ${device1Id})`);
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  // 2. Discover and resolve active endpoints
  let endpoints;
  try {
    endpoints = discoverEndpoints();
  } catch (err) {
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  const dev1 = endpoints.playbackDevices.find((d) => d.id === device1Id);
  const dev2 = endpoints.playbackDevices.find((d) => d.id === device2Id);

  if (!dev1 || !dev2) {
    const missing = [];
    if (!dev1) missing.push(`Output 1 (ID ${device1Id})`);
    if (!dev2) missing.push(`Output 2 (ID ${device2Id})`);
    const err = new Error(`Specified playback endpoint(s) not found among active devices: ${missing.join(', ')}`);
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  // 3. Mute management & Baseline Handshake (BEFORE muting)
  endpointMute = new EndpointMuteManager({ enabled: !noMute });

  if (!noMute) {
    let defaultEp;
    try {
      defaultEp = await endpointMute.queryDefault();
    } catch (err) {
      const errorMsg = `Default endpoint query failed: ${err.message}`;
      console.error(`[RUNNER FATAL] ${errorMsg}`);
      sendIpcMessage({ type: 'ERROR', error: errorMsg, fatal: true });
      updateState('ERROR', { error: errorMsg });
      process.exit(1);
    }

    const willMute = Boolean(defaultEp && !endpointMute.originallyMuted);

    // In IPC mode, execute the explicit handshake before muting
    if (typeof process.send === 'function' && process.connected) {
      sendIpcMessage({
        type: 'MUTE_BASELINE',
        endpointId: defaultEp ? defaultEp.id : null,
        endpointName: defaultEp ? defaultEp.name : null,
        originallyMuted: endpointMute.originallyMuted,
        willMute
      });

      const ackReceived = await waitForMuteBaselineAck(defaultEp ? defaultEp.id : null, 5000);
      if (!ackReceived) {
        const errorMsg = 'Mute baseline acknowledgement timeout or rejection from parent process. Aborting startup without muting.';
        console.error(`[RUNNER FATAL] ${errorMsg}`);
        sendIpcMessage({ type: 'ERROR', error: errorMsg, fatal: true });
        updateState('ERROR', { error: errorMsg });
        process.exit(1);
      }
    }

    // Only after ACK is received, execute mute operation if willMute is true
    if (willMute) {
      try {
        await endpointMute.muteTarget();
        sendIpcMessage({
          type: 'MUTE_APPLIED',
          endpointId: defaultEp.id
        });
      } catch (err) {
        const errorMsg = `Default endpoint mute execution failed: ${err.message}`;
        console.error(`[RUNNER FATAL] ${errorMsg}`);
        sendIpcMessage({ type: 'ERROR', error: errorMsg, fatal: true });
        updateState('ERROR', { error: errorMsg });
        process.exit(1);
      }
    }
  }

  // 4. Initialize PCM Converter
  const converter = new PcmConverter({
    inputSampleRate: SAMPLE_RATE,
    outputSampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frameDurationMs: 20
  });

  // 5. Initialize Output Streams with Failure Isolation
  function handleStreamError(err, failedStream) {
    const slot = failedStream === stream1 ? 'output1' : 'output2';
    const survivingStream = failedStream === stream1 ? stream2 : stream1;

    console.error(`[RUNNER ISOLATION] ${failedStream.name} encountered error: ${err.message}`);

    sendIpcMessage({
      type: 'STREAM_FAILED',
      slot,
      error: err.message
    });

    if (survivingStream && survivingStream.isActive) {
      updateState('PARTIALLY_DEGRADED', { failedSlot: slot, error: err.message });
      console.log(`[RUNNER ISOLATION] Surviving ${survivingStream.name} continues playing.`);
    } else {
      console.error('[RUNNER FATAL] Both destination streams have failed. Shutting down...');
      shutdown('All destination streams failed');
    }
  }

  stream1 = new OutputStream({
    name: 'Output 1',
    volume: vol1,
    maxCapacityMs: 200,
    targetPrebufferMs: 80,
    onError: handleStreamError
  });

  stream2 = new OutputStream({
    name: 'Output 2',
    volume: vol2,
    maxCapacityMs: 200,
    targetPrebufferMs: 80,
    onError: handleStreamError
  });

  // 6. Open WASAPI streams
  try {
    stream1.open(dev1);
  } catch (err) {
    console.error(`[RUNNER] Failed to open Output 1 on "${dev1.name}":`, err.message);
    await endpointMute.restore();
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  try {
    stream2.open(dev2);
  } catch (err) {
    console.error(`[RUNNER] Failed to open Output 2 on "${dev2.name}":`, err.message);
    stream1.close();
    await endpointMute.restore();
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  updateState('PREBUFFERING');

  // 7. Initialize WASAPI Loopback Capture
  capture = new loopback.LoopbackCapture();

  function onCaptureChunk(chunk) {
    if (isShuttingDown) return;

    // Metrics accumulation
    for (let offset = 0; offset < chunk.length; offset += 2) {
      const sample = chunk.readInt16LE(offset);
      const normalized = Math.abs(sample) / 32768.0;

      windowSamples++;
      if (normalized > windowPeak) windowPeak = normalized;
      windowSumSquares += normalized * normalized;
    }

    // Convert S16LE to 20 ms Float32LE output frames
    const outputFrames = converter.processChunk(chunk);

    // Fan-out: referentially share converted buffer across both streams
    for (let i = 0; i < outputFrames.length; i++) {
      const frame = outputFrames[i];
      if (stream1 && stream1.isActive) stream1.enqueue(frame);
      if (stream2 && stream2.isActive) stream2.enqueue(frame);
    }
  }

  try {
    // PASS process.pid so loopback-capture excludes this child process's audio!
    capture.startSystemAudio(onCaptureChunk, process.pid);
    updateState('RUNNING');
    console.log(`[RUNNER] Audio routing active with PID exclusion (${process.pid}).`);
  } catch (err) {
    console.error('[RUNNER FATAL] Failed to start system audio capture:', err.message);
    if (stream1) stream1.close();
    if (stream2) stream2.close();
    await endpointMute.restore();
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    updateState('ERROR', { error: err.message });
    process.exit(1);
  }

  // 8. Start Throttled Telemetry / Metrics Reporting (4 updates per second = 250ms)
  metricsTimer = setInterval(() => {
    if (isShuttingDown) return;

    const windowRms = windowSamples > 0 ? Math.sqrt(windowSumSquares / windowSamples) : 0;
    const windowDb = windowRms > 0 ? 20 * Math.log10(windowRms) : -96.0;
    const windowPeakDb = windowPeak > 0 ? 20 * Math.log10(windowPeak) : -96.0;

    const d1 = stream1 ? stream1.getDiagnostics() : null;
    const d2 = stream2 ? stream2.getDiagnostics() : null;

    sendIpcMessage({
      type: 'METRICS',
      timestamp: Date.now(),
      capture: {
        active: !isShuttingDown && capture !== null,
        rmsDb: isFinite(windowDb) ? Number(windowDb.toFixed(1)) : -96.0,
        peakDb: isFinite(windowPeakDb) ? Number(windowPeakDb.toFixed(1)) : -96.0
      },
      output1: d1 ? {
        state: d1.state,
        bufferHealthMs: d1.queue.queuedMs,
        underruns: d1.underrunTicks,
        drops: d1.queue.droppedBuffers
      } : null,
      output2: d2 ? {
        state: d2.state,
        bufferHealthMs: d2.queue.queuedMs,
        underruns: d2.underrunTicks,
        drops: d2.queue.droppedBuffers
      } : null
    });

    // Reset window metrics
    windowSamples = 0;
    windowSumSquares = 0.0;
    windowPeak = 0.0;
  }, 250);

  // 9. Duration timer (optional, for CLI testing)
  if (durationSec && durationSec > 0) {
    durationTimer = setTimeout(() => {
      shutdown(`Duration limit of ${durationSec}s reached`);
    }, durationSec * 1000);
  }
}

// IPC Message Listener from Main Process
if (typeof process.on === 'function') {
  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'START') {
      try {
        await startDualRouter({
          device1Id: msg.device1Id,
          device2Id: msg.device2Id,
          vol1: msg.vol1,
          vol2: msg.vol2,
          noMute: msg.noMute,
          durationSec: msg.durationSec
        });
      } catch (err) {
        sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
        updateState('ERROR', { error: err.message });
      }
    } else if (msg.type === 'SHUTDOWN') {
      await shutdown('IPC SHUTDOWN request');
    }
  });

  // Critical Safety Hook: If the parent process crashes or disconnects the IPC channel,
  // process.on('disconnect') fires immediately. Clean up and restore mute!
  process.on('disconnect', () => {
    console.warn('[RUNNER] IPC disconnected from parent process. Initiating emergency shutdown...');
    shutdown('Parent IPC disconnected');
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('\n[RUNNER FATAL UNCAUGHT EXCEPTION]:', err.message);
    sendIpcMessage({ type: 'ERROR', error: err.message, fatal: true });
    if (endpointMute) {
      endpointMute.restoreSync();
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('\n[RUNNER FATAL UNHANDLED REJECTION]:', err?.message || err);
    sendIpcMessage({ type: 'ERROR', error: err?.message || String(err), fatal: true });
    if (endpointMute) {
      endpointMute.restoreSync();
    }
    process.exit(1);
  });
}

// Direct CLI Invocation Support:
// node src/audio_runner.js --device1 <id> --device2 <id> [--vol1 <v>] [--vol2 <v>] [--no-mute] [durationSec]
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  let dev1Id = null;
  let dev2Id = null;
  let vol1Val = 1.0;
  let vol2Val = 1.0;
  let noMuteVal = false;
  let durationVal = null;

  for (let i = 0; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === '--device1' && i + 1 < cliArgs.length) {
      dev1Id = parseInt(cliArgs[++i], 10);
    } else if (a === '--device2' && i + 1 < cliArgs.length) {
      dev2Id = parseInt(cliArgs[++i], 10);
    } else if (a === '--vol1' && i + 1 < cliArgs.length) {
      vol1Val = parseFloat(cliArgs[++i]);
    } else if (a === '--vol2' && i + 1 < cliArgs.length) {
      vol2Val = parseFloat(cliArgs[++i]);
    } else if (a === '--no-mute') {
      noMuteVal = true;
    } else {
      const parsedDur = parseInt(a, 10);
      if (!isNaN(parsedDur) && parsedDur > 0 && durationVal === null) {
        durationVal = parsedDur;
      }
    }
  }

  if (dev1Id !== null && dev2Id !== null) {
    startDualRouter({
      device1Id: dev1Id,
      device2Id: dev2Id,
      vol1: vol1Val,
      vol2: vol2Val,
      noMute: noMuteVal,
      durationSec: durationVal
    }).catch((err) => {
      console.error('[RUNNER FATAL]:', err.message);
      if (endpointMute) endpointMute.restoreSync();
      process.exit(1);
    });
  }
}
