/**
 * DuoAudio - Main Process Audio Service (Phase 5C.2.1)
 *
 * Runs exclusively in the Electron main process.
 * Supervises the isolated system Node.js audio child process (`src/audio_runner.js`).
 *
 * Responsibilities:
 * 1. Preflight validation of device identifiers, software volume, and default endpoint conflicts.
 * 2. Resolves genuine system Node.js via `node-resolver.js`.
 * 3. Spawns and manages the dedicated audio runner child process via Node IPC (`stdio: ['pipe', 'pipe', 'pipe', 'ipc']`).
 * 4. Guards against duplicate start requests, race conditions, and malformed IPC messages.
 * 5. Mute Baseline IPC Handshake: Validates, stores baseline, and sends MUTE_BASELINE_ACK before child mutes.
 * 6. Guarantees emergency mute restoration in the main process if child terminates abruptly or mute state is uncertain.
 * 7. Enforces strict process-exit awaiting in stopRouting() before declaring STOPPED or permitting new sessions.
 * 8. State tracking and event dispatching for UI and IPC bridges.
 */

const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveSystemNode } = require('./node-resolver');
const { enumeratePlaybackDevices } = require('./device-service');
const { EndpointMuteManager } = require('../endpoint_mute');
const { getUnpackedPath } = require('./resource-paths');

const RUNNER_SCRIPT_PATH = getUnpackedPath('src/audio_runner.js');
const SHUTDOWN_TIMEOUT_MS = 4000;
const FORCED_TERMINATION_TIMEOUT_MS = 2000;

class AudioService {
  /**
   * @param {Object} [deps] - Dependency injection for testing
   * @param {string} [deps.nodePath] - Custom node executable path
   * @param {string} [deps.runnerScript] - Custom runner script path
   * @param {Function} [deps.enumerateFn] - Custom device enumeration function
   * @param {Function} [deps.spawnFn] - Custom child_process spawn function
   * @param {Function} [deps.nodeResolverFn] - Custom node resolution function
   * @param {Object} [deps.muteManagerClass] - Custom EndpointMuteManager class
   * @param {number} [deps.shutdownTimeoutMs] - Custom shutdown timeout duration in ms
   * @param {number} [deps.forcedTerminationTimeoutMs] - Custom forced termination deadline in ms
   */
  constructor(deps = {}) {
    this._deps = {
      nodePath: deps.nodePath || null,
      runnerScript: deps.runnerScript || RUNNER_SCRIPT_PATH,
      enumerateFn: deps.enumerateFn || enumeratePlaybackDevices,
      spawnFn: deps.spawnFn || spawn,
      nodeResolverFn: deps.nodeResolverFn || resolveSystemNode,
      muteManagerClass: deps.muteManagerClass || EndpointMuteManager,
      shutdownTimeoutMs: typeof deps.shutdownTimeoutMs === 'number' ? deps.shutdownTimeoutMs : SHUTDOWN_TIMEOUT_MS,
      forcedTerminationTimeoutMs: typeof deps.forcedTerminationTimeoutMs === 'number' ? deps.forcedTerminationTimeoutMs : FORCED_TERMINATION_TIMEOUT_MS
    };

    // State machine: IDLE, STARTING, PREBUFFERING, RUNNING, PARTIALLY_DEGRADED, STOPPING, STOPPED, ERROR
    this._state = 'IDLE';
    this._child = null;
    this._stopPromise = null;
    this._onChildExitedCallback = null;

    // Active session metadata
    this._activeConfig = null;
    this._device1 = null;
    this._device2 = null;
    this._hasDefaultConflict = false;
    this._conflictingDevice = null;
    this._lastError = null;
    this._latestMetrics = null;

    // Granular Mute State Machine
    this._muteState = {
      baselineReceived: false,
      endpointId: null,
      endpointName: null,
      originallyMuted: null,
      willMute: false,
      muteAttempted: false,
      muteApplied: false,
      restorationAttempted: false,
      restorationConfirmed: false,
      restorationStatus: 'IDLE', // 'IDLE', 'RESTORED', 'NOT_REQUIRED', 'SKIPPED', 'FAILED'
      restorationError: null
    };

    // Diagnostic buffers
    this._recentStdout = [];
    this._recentStderr = [];

    // Listeners for state / status changes
    this._statusListeners = new Set();
  }

  /**
   * Current routing state.
   * @returns {string}
   */
  get state() {
    return this._state;
  }

  /**
   * Whether routing is currently running or starting.
   * @returns {boolean}
   */
  get isRouting() {
    return (
      this._state === 'RUNNING' ||
      this._state === 'PARTIALLY_DEGRADED' ||
      this._state === 'PREBUFFERING' ||
      this._state === 'STARTING'
    );
  }

  /**
   * Registers a callback for status changes.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onStatusChanged(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Status listener must be a function.');
    }
    this._statusListeners.add(callback);
    return () => {
      this._statusListeners.delete(callback);
    };
  }

  /**
   * Removes a registered status callback.
   * @param {Function} callback
   */
  removeStatusChangedListener(callback) {
    this._statusListeners.delete(callback);
  }

  /**
   * Emits the current status snapshot to all listeners.
   * @private
   */
  _notifyStatusChanged() {
    const snapshot = this.getRoutingStatus();
    for (const listener of this._statusListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[AUDIO-SERVICE] Error in status listener:', err.message);
      }
    }
  }

  /**
   * Transitions the service state and notifies listeners.
   * @private
   * @param {string} newState
   * @param {Object} [details]
   */
  _setState(newState, details = null) {
    const oldState = this._state;
    this._state = newState;
    if (details?.error) {
      this._lastError = details.error;
    }
    console.log(`[AUDIO-SERVICE] State transition: ${oldState} -> ${newState}${details?.reason ? ` (${details.reason})` : ''}`);
    this._notifyStatusChanged();
  }

  /**
   * Returns complete routing status snapshot.
   * @returns {Object}
   */
  getRoutingStatus() {
    const isUnresolved = Boolean(
      this._muteState.willMute &&
      this._muteState.originallyMuted === false &&
      (this._muteState.restorationStatus === 'SKIPPED' || (!this._muteState.restorationConfirmed && this._muteState.muteApplied))
    );

    return {
      state: this._state,
      isRouting: this.isRouting,
      device1: this._device1 ? { id: this._device1.id, name: this._device1.name } : null,
      device2: this._device2 ? { id: this._device2.id, name: this._device2.name } : null,
      hasDefaultConflict: this._hasDefaultConflict,
      conflictingDevice: this._conflictingDevice,
      metrics: this._latestMetrics,
      error: this._lastError,
      muteState: {
        baselineReceived: this._muteState.baselineReceived,
        endpointId: this._muteState.endpointId,
        endpointName: this._muteState.endpointName,
        originallyMuted: this._muteState.originallyMuted,
        willMute: this._muteState.willMute,
        muteAttempted: this._muteState.muteAttempted,
        muteApplied: this._muteState.muteApplied,
        restorationAttempted: this._muteState.restorationAttempted,
        restorationConfirmed: this._muteState.restorationConfirmed,
        restorationStatus: this._muteState.restorationStatus,
        restorationError: this._muteState.restorationError,
        isMutedByDuoAudio: this._muteState.muteApplied && !this._muteState.restorationConfirmed,
        unresolved: isUnresolved
      }
    };
  }

  /**
   * Preflight validation of routing parameters against active WASAPI devices.
   * @param {Object} options
   * @returns {Promise<{ valid: boolean, error?: string, dev1?: Object, dev2?: Object, hasConflict?: boolean, conflictingDev?: Object }>}
   */
  async validatePreflight(options = {}) {
    const { device1Id, device2Id, vol1, vol2 } = options;

    // 1. Type and integer validation
    if (device1Id === undefined || device1Id === null || typeof device1Id !== 'number' || !Number.isInteger(device1Id)) {
      return { valid: false, error: 'Output 1 device ID must be a valid integer.' };
    }
    if (device2Id === undefined || device2Id === null || typeof device2Id !== 'number' || !Number.isInteger(device2Id)) {
      return { valid: false, error: 'Output 2 device ID must be a valid integer.' };
    }

    // 2. Reject identical devices
    if (device1Id === device2Id) {
      return { valid: false, error: 'Output 1 and Output 2 cannot be assigned to the same audio device.' };
    }

    // 3. Volume validation (if provided)
    if (vol1 !== undefined) {
      if (typeof vol1 !== 'number' || isNaN(vol1) || vol1 < 0.0 || vol1 > 1.0) {
        return { valid: false, error: `Invalid Volume 1 value: expected number between 0.0 and 1.0, got ${vol1}.` };
      }
    }
    if (vol2 !== undefined) {
      if (typeof vol2 !== 'number' || isNaN(vol2) || vol2 < 0.0 || vol2 > 1.0) {
        return { valid: false, error: `Invalid Volume 2 value: expected number between 0.0 and 1.0, got ${vol2}.` };
      }
    }

    // 4. Query live WASAPI devices
    let enumResult;
    try {
      enumResult = await this._deps.enumerateFn();
    } catch (err) {
      return { valid: false, error: `Device enumeration failed during preflight check: ${err.message}` };
    }

    if (!enumResult || !enumResult.success || !Array.isArray(enumResult.devices)) {
      return { valid: false, error: `Active audio device list unavailable: ${enumResult?.error || 'Unknown error'}` };
    }

    const playbackDevices = enumResult.devices;

    const dev1 = playbackDevices.find((d) => d.id === device1Id);
    if (!dev1) {
      return { valid: false, error: `Output 1 device (ID: ${device1Id}) is not currently connected or available.` };
    }
    if (typeof dev1.outputChannels !== 'number' || dev1.outputChannels <= 0) {
      return { valid: false, error: `Output 1 device "${dev1.name}" (ID: ${device1Id}) has no available output playback channels.` };
    }

    const dev2 = playbackDevices.find((d) => d.id === device2Id);
    if (!dev2) {
      return { valid: false, error: `Output 2 device (ID: ${device2Id}) is not currently connected or available.` };
    }
    if (typeof dev2.outputChannels !== 'number' || dev2.outputChannels <= 0) {
      return { valid: false, error: `Output 2 device "${dev2.name}" (ID: ${device2Id}) has no available output playback channels.` };
    }

    // 5. Default output conflict detection
    const isDev1Default = Boolean(dev1.isDefault);
    const isDev2Default = Boolean(dev2.isDefault);
    const hasConflict = isDev1Default || isDev2Default;
    const conflictingDev = isDev1Default ? dev1 : (isDev2Default ? dev2 : null);

    return {
      valid: true,
      dev1,
      dev2,
      hasConflict,
      conflictingDev
    };
  }

  /**
   * Forcibly terminates a child process and its process tree on Windows.
   * @private
   * @param {ChildProcess} child
   */
  _forceKillProcess(child) {
    if (!child || child.killed || child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      try {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], (err) => {
          if (err) {
            try { child.kill('SIGKILL'); } catch (_) {}
          }
        });
      } catch (_) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    } else {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  }

  /**
   * Starts dual-output audio routing.
   * Spawns the dedicated system Node.js child process and establishes IPC supervision.
   *
   * @param {Object} options
   * @param {number} options.device1Id
   * @param {number} options.device2Id
   * @param {number} [options.vol1=1.0]
   * @param {number} [options.vol2=1.0]
   * @param {boolean} [options.noMute=false]
   * @param {number} [options.durationSec=null]
   * @returns {Promise<{ success: boolean, state: string, error?: string }>}
   */
  async startRouting(options = {}) {
    // Guard: Prevent duplicate start calls and ensure no previous child is still terminating
    if (this._child !== null || this.isRouting || this._state === 'STARTING' || this._state === 'STOPPING') {
      const msg = `Audio routing is already active or a previous session is still terminating (current state: "${this._state}").`;
      console.warn(`[AUDIO-SERVICE] Start request rejected: ${msg}`);
      return { success: false, state: this._state, error: msg };
    }

    this._lastError = null;
    this._latestMetrics = null;

    // Reset mute state machine for new session
    this._muteState = {
      baselineReceived: false,
      endpointId: null,
      endpointName: null,
      originallyMuted: null,
      willMute: false,
      muteAttempted: false,
      muteApplied: false,
      restorationAttempted: false,
      restorationConfirmed: false,
      restorationStatus: 'IDLE',
      restorationError: null
    };

    // Guard 2: Preflight validation
    const preflight = await this.validatePreflight(options);
    if (!preflight.valid) {
      this._lastError = preflight.error;
      this._setState('ERROR', { error: preflight.error });
      return { success: false, state: 'ERROR', error: preflight.error };
    }

    this._device1 = preflight.dev1;
    this._device2 = preflight.dev2;
    this._hasDefaultConflict = preflight.hasConflict;
    this._conflictingDevice = preflight.conflictingDev;

    if (this._hasDefaultConflict) {
      console.warn(`[AUDIO-SERVICE] [DEFAULT OUTPUT CONFLICT] Device "${this._conflictingDevice.name}" is the active Windows default output.`);
    }

    // Guard 3: Resolve genuine system Node.js
    let nodePath = this._deps.nodePath;
    if (!nodePath) {
      const nodeResolution = this._deps.nodeResolverFn();
      if (!nodeResolution.success || !nodeResolution.nodePath) {
        const errorMsg = `System Node.js resolution failed: ${nodeResolution.error}`;
        this._lastError = errorMsg;
        this._setState('ERROR', { error: errorMsg });
        return { success: false, state: 'ERROR', error: errorMsg };
      }
      nodePath = nodeResolution.nodePath;
    }

    // Transition to STARTING
    this._setState('STARTING');

    const vol1 = options.vol1 !== undefined ? options.vol1 : 1.0;
    const vol2 = options.vol2 !== undefined ? options.vol2 : 1.0;
    const noMute = Boolean(options.noMute);
    const durationSec = options.durationSec || null;

    const spawnArgs = [
      this._deps.runnerScript,
      '--device1', String(options.device1Id),
      '--device2', String(options.device2Id),
      '--vol1', String(vol1),
      '--vol2', String(vol2)
    ];

    if (noMute) spawnArgs.push('--no-mute');
    if (durationSec) spawnArgs.push(String(durationSec));

    return new Promise((resolve) => {
      let childProcess;
      let startTimeoutTimer = null;
      let resolved = false;

      const safeResolve = (result) => {
        if (resolved) return;
        resolved = true;
        if (startTimeoutTimer) clearTimeout(startTimeoutTimer);
        resolve(result);
      };

      try {
        console.log(`[AUDIO-SERVICE] Spawning audio runner with genuine Node: ${nodePath}`);
        const runnerDir = path.dirname(this._deps.runnerScript);
        childProcess = this._deps.spawnFn(nodePath, spawnArgs, {
          cwd: runnerDir,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
          env: { ...process.env }
        });
      } catch (err) {
        const errorMsg = `Failed to spawn audio child process: ${err.message}`;
        console.error(`[AUDIO-SERVICE] ${errorMsg}`);
        this._lastError = errorMsg;
        this._setState('ERROR', { error: errorMsg });
        return safeResolve({ success: false, state: 'ERROR', error: errorMsg });
      }

      // Capture active child reference
      const currentChild = childProcess;
      this._child = childProcess;

      // Capture stdout / stderr for diagnostics
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data) => {
          const text = data.toString();
          this._recentStdout.push(text);
          if (this._recentStdout.length > 50) this._recentStdout.shift();
        });
      }

      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
          const text = data.toString();
          this._recentStderr.push(text);
          if (this._recentStderr.length > 50) this._recentStderr.shift();
          console.error(`[AUDIO-RUNNER STDERR] ${text.trim()}`);
        });
      }

      // 10-second startup timeout guard
      startTimeoutTimer = setTimeout(() => {
        if (this._state === 'STARTING') {
          const timeoutErr = 'Audio runner startup timed out after 10000ms.';
          console.error(`[AUDIO-SERVICE] ${timeoutErr}`);
          this._lastError = timeoutErr;
          this.stopRouting().catch(() => {});
          safeResolve({ success: false, state: 'ERROR', error: timeoutErr });
        }
      }, 10000);

      // Handle IPC messages from child
      childProcess.on('message', (msg) => {
        this._handleChildIpcMessage(childProcess, msg, (stateResult) => {
          if (stateResult.state === 'RUNNING' || stateResult.state === 'PREBUFFERING') {
            safeResolve({ success: true, state: stateResult.state });
          } else if (stateResult.state === 'ERROR') {
            safeResolve({ success: false, state: 'ERROR', error: stateResult.error });
          }
        });
      });

      // Handle child exit
      childProcess.on('exit', async (code, signal) => {
        console.log(`[AUDIO-SERVICE] Child process exited with code=${code}, signal=${signal}.`);
        clearTimeout(startTimeoutTimer);

        // Guard against stale child exit event from a previous session
        if (this._child !== currentChild) {
          console.log('[AUDIO-SERVICE] Ignoring exit event from previous stale child process.');
          return;
        }

        const wasExpectedStop = (
          this._state === 'STOPPING' ||
          this._state === 'STOPPED' ||
          currentChild._stopRequested === true
        );

        // Critical Safety Check: Crash-window handling & uncertain mute application.
        // If baseline was received for an unmuted endpoint and mute was attempted/applied,
        // but restoration was NOT confirmed (e.g. child crashed or restoration failed):
        const needsEmergencyRestoration = (
          this._muteState.baselineReceived &&
          this._muteState.originallyMuted === false &&
          this._muteState.willMute === true &&
          !this._muteState.restorationConfirmed &&
          this._muteState.restorationStatus !== 'SKIPPED'
        );

        if (needsEmergencyRestoration && this._muteState.endpointId) {
          console.warn(`[AUDIO-SERVICE] Emergency mute restoration triggered for endpoint "${this._muteState.endpointId}"...`);
          this._muteState.restorationAttempted = true;
          try {
            const restoreRes = await this._deps.muteManagerClass.restoreEndpointById(this._muteState.endpointId);
            if (restoreRes.restored || restoreRes.status === 'RESTORED') {
              this._muteState.restorationConfirmed = true;
              this._muteState.restorationStatus = 'RESTORED';
              console.log('[AUDIO-SERVICE] Emergency mute restoration completed successfully.');
            } else if (restoreRes.status === 'SKIPPED') {
              // Endpoint is disconnected. If it was originally muted, restoration was not needed.
              // If it was originally unmuted and muted by DuoAudio, restoration could not be applied.
              // Never overwrite SKIPPED with RESTORED!
              if (this._muteState.originallyMuted === true || !this._muteState.willMute) {
                this._muteState.restorationConfirmed = true;
                this._muteState.restorationStatus = 'SKIPPED';
              } else {
                this._muteState.restorationConfirmed = false;
                this._muteState.restorationStatus = 'SKIPPED';
                console.warn('[AUDIO-SERVICE] Emergency mute restoration skipped: endpoint disconnected (unresolved).');
              }
            } else if (restoreRes.status === 'NOT_REQUIRED') {
              this._muteState.restorationConfirmed = true;
              this._muteState.restorationStatus = 'NOT_REQUIRED';
            } else {
              this._muteState.restorationConfirmed = false;
              this._muteState.restorationStatus = 'FAILED';
              this._muteState.restorationError = restoreRes.error || 'Emergency restoration failed';
              console.error('[AUDIO-SERVICE] Emergency mute restoration failed:', this._muteState.restorationError);
            }
          } catch (restoreErr) {
            this._muteState.restorationConfirmed = false;
            this._muteState.restorationStatus = 'FAILED';
            this._muteState.restorationError = restoreErr.message;
            console.error('[AUDIO-SERVICE] Emergency mute restoration threw error:', restoreErr.message);
          }
        }

        // Child process has officially terminated; only NOW do we clear this._child
        this._child = null;

        // Determine final service state before resolving in-flight stop promise
        if (this._muteState.restorationStatus === 'FAILED') {
          const errorMsg = this._muteState.restorationError || 'Endpoint mute restoration failed';
          this._lastError = errorMsg;
          this._setState('ERROR', { error: errorMsg });
          safeResolve({ success: false, state: 'ERROR', error: errorMsg });
        } else if (!wasExpectedStop) {
          const exitErr = `Audio child process terminated unexpectedly (code: ${code}, signal: ${signal}).`;
          console.error(`[AUDIO-SERVICE] ${exitErr}`);
          this._lastError = exitErr;
          this._setState('ERROR', { error: exitErr });
          safeResolve({ success: false, state: 'ERROR', error: exitErr });
        } else {
          if (this._state === 'ERROR' && currentChild._stopRequested) {
            console.log('[AUDIO-SERVICE] Child process eventually exited after termination timeout. Reconciled state to STOPPED.');
          }
          this._setState('STOPPED');
        }

        // Notify in-flight stopRouting promise if waiting
        if (this._onChildExitedCallback) {
          const cb = this._onChildExitedCallback;
          this._onChildExitedCallback = null;
          await cb();
        }
      });

      // Handle spawn error
      childProcess.on('error', (err) => {
        console.error('[AUDIO-SERVICE] Child process spawn error:', err.message);
        clearTimeout(startTimeoutTimer);
        this._lastError = err.message;
        this._setState('ERROR', { error: err.message });
        safeResolve({ success: false, state: 'ERROR', error: err.message });
      });
    });
  }

  /**
   * Dispatches and processes structured IPC messages from the audio child.
   * @private
   * @param {ChildProcess} childProcess
   * @param {Object} msg
   * @param {Function} onStateCallback
   */
  _handleChildIpcMessage(childProcess, msg, onStateCallback) {
    // Malformed message guard
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      console.warn('[AUDIO-SERVICE] Received malformed or non-object IPC message from child:', msg);
      return;
    }

    switch (msg.type) {
      case 'MUTE_BASELINE': {
        // Child reports baseline BEFORE muting. Store baseline and acknowledge immediately.
        this._muteState.baselineReceived = true;
        this._muteState.endpointId = msg.endpointId;
        this._muteState.endpointName = msg.endpointName;
        this._muteState.originallyMuted = Boolean(msg.originallyMuted);
        this._muteState.willMute = Boolean(msg.willMute);
        this._muteState.muteAttempted = Boolean(msg.willMute);
        this._muteState.muteApplied = false;
        this._muteState.restorationAttempted = false;
        this._muteState.restorationConfirmed = false;
        this._muteState.restorationStatus = 'IDLE';
        this._muteState.restorationError = null;

        console.log(`[AUDIO-SERVICE] Mute baseline recorded: endpoint="${msg.endpointName}", originallyMuted=${msg.originallyMuted}, willMute=${msg.willMute}`);

        // Send explicit ACK back to child so it knows it is authorized to mute
        if (childProcess && childProcess.connected) {
          try {
            childProcess.send({
              type: 'MUTE_BASELINE_ACK',
              endpointId: msg.endpointId
            });
            console.log(`[AUDIO-SERVICE] Sent MUTE_BASELINE_ACK for endpoint: ${msg.endpointId}`);
          } catch (e) {
            console.warn('[AUDIO-SERVICE] Failed to send MUTE_BASELINE_ACK:', e.message);
          }
        }
        break;
      }

      case 'MUTE_APPLIED': {
        if (msg.endpointId === this._muteState.endpointId) {
          this._muteState.muteApplied = true;
          console.log(`[AUDIO-SERVICE] Mute application confirmed for endpoint "${msg.endpointId}".`);
        }
        break;
      }

      case 'MUTE_RESTORATION_RESULT': {
        this._muteState.restorationAttempted = true;
        this._muteState.restorationStatus = msg.status;
        this._muteState.restorationError = msg.error || null;

        if (msg.status === 'RESTORED' || msg.status === 'NOT_REQUIRED') {
          this._muteState.restorationConfirmed = true;
          console.log(`[AUDIO-SERVICE] Mute restoration confirmed with status "${msg.status}".`);
        } else if (msg.status === 'SKIPPED') {
          // If the endpoint was already muted before routing, no restoration was needed (confirmed safe).
          // If DuoAudio muted an originally unmuted endpoint, restoration is UNRESOLVED.
          if (this._muteState.originallyMuted === true || !this._muteState.willMute) {
            this._muteState.restorationConfirmed = true;
            console.log('[AUDIO-SERVICE] Mute restoration skipped: endpoint was originally muted (confirmed safe).');
          } else {
            this._muteState.restorationConfirmed = false;
            console.warn('[AUDIO-SERVICE] Mute restoration skipped: endpoint disconnected before unmuting (unresolved).');
          }
        } else {
          this._muteState.restorationConfirmed = false;
          console.error(`[AUDIO-SERVICE] Child reported mute restoration failure: ${msg.error}`);
        }
        break;
      }

      case 'STATE_CHANGE': {
        const nextState = msg.state;
        if (typeof nextState === 'string') {
          this._setState(nextState, msg.details);
          if (onStateCallback) onStateCallback({ state: nextState });
        }
        break;
      }

      case 'METRICS': {
        this._latestMetrics = {
          timestamp: msg.timestamp || Date.now(),
          capture: msg.capture || null,
          output1: msg.output1 || null,
          output2: msg.output2 || null
        };
        this._notifyStatusChanged();
        break;
      }

      case 'STREAM_FAILED': {
        const errorMsg = `Stream on ${msg.slot} failed: ${msg.error}`;
        console.warn(`[AUDIO-SERVICE] ${errorMsg}`);
        this._lastError = errorMsg;
        this._setState('PARTIALLY_DEGRADED', { failedSlot: msg.slot, error: errorMsg });
        break;
      }

      case 'STOPPED': {
        console.log('[AUDIO-SERVICE] Child process confirmed audio streams and capture stopped.');
        // NOTE: We do NOT clear mute restoration flags here; we await process exit and restoration confirmation
        break;
      }

      case 'ERROR': {
        console.error(`[AUDIO-SERVICE] Child process reported error: ${msg.error}`);
        this._lastError = msg.error;
        this._setState('ERROR', { error: msg.error });
        if (onStateCallback) onStateCallback({ state: 'ERROR', error: msg.error });
        break;
      }

      default: {
        console.warn(`[AUDIO-SERVICE] Received unknown IPC message type: "${msg.type}"`);
        break;
      }
    }
  }

  /**
   * Gracefully stops dual-output audio routing.
   * Sends IPC SHUTDOWN message to child and applies a bounded timeout fallback.
   * STRICT GUARANTEE: Does NOT resolve until the child process has actually exited.
   *
   * @returns {Promise<{ success: boolean, state: string, error?: string }>}
   */
  stopRouting() {
    // Guard 1: already stopped or idle
    if (this._child === null || this._state === 'IDLE' || this._state === 'STOPPED') {
      return Promise.resolve({ success: true, state: this._state });
    }

    // Guard 2: already stopping, share in-flight stop promise
    if (this._state === 'STOPPING' && this._stopPromise) {
      return this._stopPromise;
    }

    this._setState('STOPPING');
    const child = this._child;
    child._stopRequested = true;

    this._stopPromise = new Promise((resolve) => {
      let resolved = false;
      let killTimer = null;
      let hardKillTimer = null;

      const finishStop = (result) => {
        if (resolved) return;
        resolved = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        this._stopPromise = null;
        resolve(result);
      };

      // Set callback to be executed strictly when childProcess.on('exit') fires
      this._onChildExitedCallback = async () => {
        if (this._muteState.restorationStatus === 'FAILED') {
          finishStop({ success: false, state: 'ERROR', error: this._muteState.restorationError || 'Mute restoration failed' });
        } else {
          finishStop({ success: true, state: 'STOPPED' });
        }
      };

      // If child process has already terminated (check actual exit state, NOT child.killed):
      if (child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined)) {
        if (this._onChildExitedCallback) {
          const cb = this._onChildExitedCallback;
          this._onChildExitedCallback = null;
          cb();
        }
        return;
      }

      // Timeout fallback timer (configurable via deps.shutdownTimeoutMs, defaults to 4000)
      const timeoutMs = this._deps.shutdownTimeoutMs || SHUTDOWN_TIMEOUT_MS;
      const hardTimeoutMs = this._deps.forcedTerminationTimeoutMs || FORCED_TERMINATION_TIMEOUT_MS;

      killTimer = setTimeout(() => {
        console.warn(`[AUDIO-SERVICE] Graceful child shutdown timed out after ${timeoutMs}ms. Initiating forced termination...`);
        this._forceKillProcess(child);

        // Secondary hard timeout: if child still has not exited after forced termination deadline
        hardKillTimer = setTimeout(() => {
          if (this._child === child && child.exitCode === null && (child.signalCode === null || child.signalCode === undefined)) {
            const hardTimeoutErr = `Child process (PID: ${child.pid}) failed to exit within deadline after forced termination.`;
            console.error(`[AUDIO-SERVICE] ${hardTimeoutErr}`);
            this._lastError = hardTimeoutErr;
            this._setState('ERROR', { error: hardTimeoutErr });

            // Clear in-flight callback so late exit handler does not double-resolve
            this._onChildExitedCallback = null;

            // Retain child reference (do NOT null this._child) and keep exit listeners attached.
            // This prevents starting another session while the runner may still be alive in kernel.
            finishStop({ success: false, state: 'ERROR', error: hardTimeoutErr });
          }
        }, hardTimeoutMs);
      }, timeoutMs);

      // Send SHUTDOWN message over IPC
      try {
        if (child && child.connected) {
          child.send({ type: 'SHUTDOWN' });
        } else if (child) {
          this._forceKillProcess(child);
        }
      } catch (err) {
        console.warn('[AUDIO-SERVICE] Error sending SHUTDOWN IPC message:', err.message);
        this._forceKillProcess(child);
      }
    });

    return this._stopPromise;
  }
}

// Singleton instance for the main process
const audioService = new AudioService();

module.exports = {
  AudioService,
  audioService,
  SHUTDOWN_TIMEOUT_MS,
  FORCED_TERMINATION_TIMEOUT_MS
};
