/**
 * DuoAudio - Phase 7.1B: Windows Core Audio Endpoint Mute Manager
 *
 * Automatically mutes the active Windows default playback endpoint at routing
 * startup to ensure physical speakers remain silent in the room while dual
 * Bluetooth earbuds receive audio, and reliably restores the original mute
 * state upon coordinated shutdown.
 *
 * Primary execution engine:
 * - Standalone native C++ Windows executable (duoaudio_endpoint.exe)
 *   utilizing direct Windows Core Audio COM APIs (IMMDeviceEnumerator, IAudioEndpointVolume, IPolicyConfig).
 *
 * Safety & Resilience:
 * - Dynamic default endpoint resolution and friendly name extraction.
 * - Idempotent asynchronous and synchronous restoration hooks.
 * - Preservation of pre-session muted state (never un-mutes an already muted device).
 * - Targeted restoration by device GUID (immune to default device changes mid-session).
 * - Safe handling of disconnected endpoints.
 * - Explicit unresolved state tracking and verified recovery unmuting.
 */

const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const ENDPOINT_TIMEOUT_MS = 5000;

/**
 * Resolves the path to the native Windows audio endpoint helper executable.
 * Checks candidate paths across development and packaged environments.
 * @returns {string} Absolute on-disk path to duoaudio_endpoint.exe
 */
function resolveDefaultNativeHelperPath() {
  if (process.env.DUOAUDIO_HELPER_PATH && fs.existsSync(process.env.DUOAUDIO_HELPER_PATH)) {
    return process.env.DUOAUDIO_HELPER_PATH;
  }
  // 1. Packaged location if running in Electron with process.resourcesPath
  if (process.resourcesPath) {
    const packagedPath = path.join(process.resourcesPath, 'bin', 'duoaudio_endpoint.exe');
    if (fs.existsSync(packagedPath)) return packagedPath;
  }
  // 2. Packaged location if running in unpacked ASAR (external Node audio runner)
  // __dirname: <installDir>/resources/app.asar.unpacked/src -> ../../bin/duoaudio_endpoint.exe
  const unpackedCandidate = path.resolve(__dirname, '../../bin/duoaudio_endpoint.exe');
  if (fs.existsSync(unpackedCandidate)) return unpackedCandidate;

  // 3. Root development location: <projectRoot>/duoaudio_endpoint.exe
  const rootCandidate = path.resolve(__dirname, '../duoaudio_endpoint.exe');
  if (fs.existsSync(rootCandidate)) return rootCandidate;

  // 4. Staged development location: <projectRoot>/resources/bin/duoaudio_endpoint.exe
  const stagedCandidate = path.resolve(__dirname, '../resources/bin/duoaudio_endpoint.exe');
  if (fs.existsSync(stagedCandidate)) return stagedCandidate;

  // Default fallback to rootCandidate path
  return rootCandidate;
}

class EndpointMuteManager {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true] - Set false (via --no-mute) to disable automatic muting
   * @param {string} [options.nativePath] - Custom native helper executable path override
   * @param {string} [options.helperPath] - Alias for nativePath
   * @param {string} [options.scriptPath] - Custom script path override
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.nativePath = options.nativePath || options.helperPath || resolveDefaultNativeHelperPath();

    this.targetEndpoint = null; // { id, name, isMuted, volume }
    this.originallyMuted = null;
    this.isMutedByDuoAudio = false;
    this.isRestored = false;
    this.restorationPromise = null;

    // Automatic Windows default endpoint tracking and restoration
    this.originalDefaultEndpoint = null; // { id, name }
    this.defaultSwitchedByDuoAudio = false;
    this.isDefaultRestored = false;
    this.defaultRestorationPromise = null;
  }

  /**
   * Discovers the current Windows default playback endpoint and queries its mute state.
   * @returns {Promise<{ id: string, name: string, isMuted: boolean, volume: number }>}
   */
  async queryDefault() {
    if (!this.enabled) {
      return null;
    }

    let queryResult;
    try {
      queryResult = await this._runAsync(["query-default"]);
    } catch (err) {
      throw new Error(`Failed to query Windows default playback endpoint: ${err.message}`);
    }

    if (!queryResult.success) {
      throw new Error(`Windows Core Audio query failed: ${queryResult.error || "Unknown error"}`);
    }

    this.targetEndpoint = {
      id: queryResult.id,
      name: queryResult.name || "Default Audio Device",
      isMuted: queryResult.isMuted,
      volume: queryResult.volume
    };
    this.originallyMuted = queryResult.isMuted;

    return this.targetEndpoint;
  }

  /**
   * Discovers the current Windows default playback endpoint and mutes it if unmuted.
   * Must be called during pre-flight checks before audio capture and playback start.
   *
   * @param {Function} [onBaseline] - Optional callback receiving baseline info before muting: (baseline) => void
   * @returns {Promise<{ muted: boolean, originallyMuted: boolean, endpoint: Object }>}
   */
  async initAndMute(onBaseline) {
    if (!this.enabled) {
      console.log("[MUTE] Automatic default endpoint muting disabled (--no-mute specified).\n");
      return { muted: false, originallyMuted: false, endpoint: null };
    }

    // Step 1: Query current default endpoint info if not already queried
    if (!this.targetEndpoint) {
      await this.queryDefault();
    }

    console.log(`[MUTE] Active Windows default playback endpoint:`);
    console.log(`       Name  : "${this.targetEndpoint.name}"`);
    console.log(`       ID    : ${this.targetEndpoint.id}`);
    console.log(`       State : ${this.originallyMuted ? "MUTED" : "UNMUTED"}`);

    // Report baseline if callback provided (before muting occurs!)
    if (typeof onBaseline === "function") {
      try {
        onBaseline({
          endpointId: this.targetEndpoint.id,
          endpointName: this.targetEndpoint.name,
          originallyMuted: this.originallyMuted,
          willMute: !this.originallyMuted
        });
      } catch (e) {
        console.error("[MUTE] Baseline callback error:", e.message);
      }
    }

    return this.muteTarget();
  }

  /**
   * Mutes the target default endpoint that was previously queried via queryDefault().
   * @returns {Promise<{ muted: boolean, originallyMuted: boolean, endpoint: Object }>}
   */
  async muteTarget() {
    if (!this.enabled) {
      return { muted: false, originallyMuted: false, endpoint: null };
    }

    if (!this.targetEndpoint) {
      throw new Error("No target endpoint queried before calling muteTarget()");
    }

    // Step 2: Evaluate pre-flight baseline
    if (this.originallyMuted === true) {
      console.log(`[MUTE] Endpoint is already muted. Preserving pre-session mute state.\n`);
      return { muted: false, originallyMuted: true, endpoint: this.targetEndpoint };
    }

    // Step 3: Mute the endpoint
    console.log(`[MUTE] Muting "${this.targetEndpoint.name}" for dual routing...`);
    let muteResult;
    try {
      muteResult = await this._runAsync(["mute-by-id", this.targetEndpoint.id]);
    } catch (err) {
      throw new Error(`Failed to mute endpoint "${this.targetEndpoint.name}": ${err.message}`);
    }

    if (!muteResult.success || muteResult.newMute !== true) {
      throw new Error(`Verification failed: endpoint "${this.targetEndpoint.name}" is not muted.`);
    }

    this.isMutedByDuoAudio = true;
    console.log(`[MUTE] Mute verified. Physical speakers will remain silent in the room.\n`);

    return { muted: true, originallyMuted: false, endpoint: this.targetEndpoint };
  }

  /**
   * Attempts recovery unmuting of target endpoint and verifies resulting state.
   * Required for Case B (failed muteTarget) to ensure endpoint was not left muted by partial COM execution.
   *
   * @returns {Promise<{ success: boolean, verifiedUnmuted: boolean, status: string, error?: string, endpointId?: string }>}
   */
  async unmuteAndVerify() {
    if (!this.targetEndpoint || !this.targetEndpoint.id) {
      return { success: false, verifiedUnmuted: false, status: "UNRESOLVED", error: "No target endpoint known" };
    }

    // Safety invariant: If endpoint was originally muted before routing started, NEVER unmute it!
    if (this.originallyMuted === true) {
      this.isRestored = true;
      this.isMutedByDuoAudio = false;
      return { success: true, verifiedUnmuted: false, status: "NOT_REQUIRED", reason: "Preserved original muted state", endpointId: this.targetEndpoint.id };
    }

    try {
      const res = await this._runAsync(["unmute-by-id", this.targetEndpoint.id]);
      if (res && res.success && res.newMute === false) {
        this.isRestored = true;
        this.isMutedByDuoAudio = false;
        return { success: true, verifiedUnmuted: true, status: "RESTORED", endpointId: this.targetEndpoint.id };
      } else {
        const errMsg = res ? (res.error || (res.newMute !== false ? "Device verification indicated endpoint is still muted" : "Unmute failed")) : "No response from helper";
        return { success: false, verifiedUnmuted: false, status: "UNRESOLVED", error: errMsg, endpointId: this.targetEndpoint.id };
      }
    } catch (err) {
      return { success: false, verifiedUnmuted: false, status: "UNRESOLVED", error: err.message, endpointId: this.targetEndpoint.id };
    }
  }

  /**
   * Asynchronous idempotent restoration for graceful shutdown (SIGINT, SIGTERM, normal exit).
   * Restores the exact endpoint that was muted at startup.
   *
   * @returns {Promise<{ restored: boolean, status: string, endpointId?: string, error?: string, reason?: string, skipped?: boolean }>}
   */
  async restore() {
    if (!this.enabled) {
      return { restored: false, status: "NOT_REQUIRED", reason: "Mute manager disabled" };
    }

    if (this.isRestored) {
      return { restored: false, skipped: true, status: "SKIPPED", reason: "Already restored", endpointId: this.targetEndpoint?.id };
    }

    if (this.restorationPromise) {
      return this.restorationPromise;
    }

    // If device was already muted before starting, do not unmute
    if (this.originallyMuted === true) {
      this.isRestored = true;
      if (this.targetEndpoint) {
        console.log(`[MUTE] Preserved original muted state for "${this.targetEndpoint.name}".`);
      }
      return { restored: false, status: "NOT_REQUIRED", reason: "Preserved original pre-session mute state", endpointId: this.targetEndpoint?.id };
    }

    // If DuoAudio never muted the device and mute was not ambiguous/unresolved:
    if (!this.isMutedByDuoAudio) {
      this.isRestored = true;
      return { restored: false, status: "NOT_REQUIRED", reason: "Preserved original pre-session mute state", endpointId: this.targetEndpoint?.id };
    }

    if (!this.targetEndpoint || !this.targetEndpoint.id) {
      this.isRestored = true;
      return { restored: false, status: "NOT_REQUIRED", reason: "No target endpoint known" };
    }

    this.restorationPromise = (async () => {
      console.log(`[MUTE] Restoring original unmuted state for "${this.targetEndpoint.name}"...`);
      try {
        const res = await this._runAsync(["unmute-by-id", this.targetEndpoint.id]);
        if (res && res.success && res.newMute === false) {
          console.log(`[MUTE] Restored "${this.targetEndpoint.name}" to unmuted state.`);
          this.isRestored = true;
          this.isMutedByDuoAudio = false;
          return { restored: true, status: "RESTORED", endpointId: this.targetEndpoint.id };
        } else if (res && res.success && res.newMute !== false) {
          console.error(`[MUTE ERROR] Unmute verification failed for "${this.targetEndpoint.name}": endpoint remains muted.`);
          return { restored: false, status: "FAILED", error: "Endpoint verification failed: device remains muted", endpointId: this.targetEndpoint.id };
        } else {
          // Check for disconnected device (0x80070490)
          if ((res.error || "").includes("0x80070490") || (res.hresult || "").includes("80070490") || (res.error || "").includes("not found")) {
            console.warn(`[MUTE NOTICE] Muted endpoint was disconnected; restoration skipped safely.`);
            this.isRestored = true;
            this.isMutedByDuoAudio = false;
            return { restored: false, status: "SKIPPED", reason: "Endpoint disconnected", endpointId: this.targetEndpoint.id };
          }
          console.error(`[MUTE ERROR] Failed to unmute "${this.targetEndpoint.name}":`, res.error);
          return { restored: false, status: "FAILED", error: res.error, endpointId: this.targetEndpoint.id };
        }
      } catch (err) {
        console.error(`[MUTE ERROR] Restoration error:`, err.message);
        return { restored: false, status: "FAILED", error: err.message, endpointId: this.targetEndpoint.id };
      }
    })();

    return this.restorationPromise;
  }

  /**
   * Synchronous emergency restoration for uncaught exceptions and abnormal process exits.
   * Uses execFileSync to guarantee execution before the Node.js process terminates.
   */
  restoreSync() {
    if (!this.enabled || this.isRestored || !this.isMutedByDuoAudio || this.originallyMuted === true || !this.targetEndpoint || !this.targetEndpoint.id) {
      this.isRestored = true;
      return;
    }

    try {
      console.error(`[MUTE EMERGENCY] Restoring unmuted state on "${this.targetEndpoint.name}" synchronously...`);
      const raw = this._runSync(["unmute-by-id", this.targetEndpoint.id]);
      const res = JSON.parse(raw);
      if (res && res.success && res.newMute === false) {
        console.error(`[MUTE EMERGENCY] Restoration complete.`);
      }
    } catch (e) {
      // Best-effort in emergency handler
    } finally {
      this.isRestored = true;
      this.isMutedByDuoAudio = false;
    }
  }

  /**
   * Queries all active Windows render endpoints with their Windows Core Audio IDs and friendly names.
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  async listEndpoints() {
    try {
      const res = await this._runAsync(["list-endpoints"]);
      if (res && res.success && Array.isArray(res.devices)) {
        return res.devices;
      }
      return [];
    } catch (err) {
      console.warn(`[ENDPOINT WARNING] Failed to list endpoints: ${err.message}`);
      return [];
    }
  }

  /**
   * Identifies the built-in PC speaker endpoint from a list of devices.
   * Prioritizes internal physical speakers (Realtek, High Definition Audio, Speaker)
   * while filtering out Bluetooth devices, earbuds, headsets, and virtual sinks.
   *
   * @param {Array<{ id: string|number, name: string }>} availableDevices
   * @returns {{ id: string|number, name: string }|null}
   */
  identifyBuiltInSpeakers(availableDevices) {
    if (!Array.isArray(availableDevices) || availableDevices.length === 0) {
      return null;
    }

    const bluetoothRegex = /(?:bluetooth|hands-free|buds|airpod|airdopes|tws|headphone|wireless|headset)/i;
    const speakerRegex = /(?:speaker|internal|built-in|realtek|conexant|high definition audio)/i;

    // Filter out Bluetooth/headset devices
    const nonBluetooth = availableDevices.filter(
      (d) => d && typeof d.name === "string" && !bluetoothRegex.test(d.name)
    );

    // Priority 1: Non-Bluetooth device matching known speaker keywords
    const matchingSpeaker = nonBluetooth.find((d) => speakerRegex.test(d.name));
    if (matchingSpeaker) {
      return matchingSpeaker;
    }

    // Priority 2: Any non-Bluetooth audio device
    if (nonBluetooth.length > 0) {
      return nonBluetooth[0];
    }

    // Priority 3: Fallback to any device matching speakerRegex
    const anySpeaker = availableDevices.find(
      (d) => d && typeof d.name === "string" && speakerRegex.test(d.name)
    );
    if (anySpeaker) {
      return anySpeaker;
    }

    // Fallback: first available device
    return availableDevices[0] || null;
  }

  /**
   * Switches the Windows default playback endpoint to the specified endpointId.
   * @param {string} endpointId
   * @returns {Promise<{ success: boolean, id: string, verified: boolean }>}
   */
  async setDefaultEndpoint(endpointId) {
    if (!endpointId) {
      throw new Error("No endpoint ID provided to setDefaultEndpoint");
    }

    let res;
    try {
      res = await this._runAsync(["set-default-by-id", endpointId]);
    } catch (err) {
      throw new Error(`Failed to set Windows default endpoint: ${err.message}`);
    }

    if (!res || !res.success || !res.verified) {
      throw new Error(`Windows default endpoint switch failed: ${res?.error || "Verification failed"}`);
    }

    return res;
  }

  /**
   * Restores the original Windows default playback endpoint if it was changed by DuoAudio.
   * @returns {Promise<{ restored: boolean, status: string, endpointId?: string, error?: string }>}
   */
  async restoreDefaultEndpoint() {
    if (!this.defaultSwitchedByDuoAudio || this.isDefaultRestored) {
      return { restored: false, status: "NOT_REQUIRED", reason: "Default endpoint was not switched or already restored" };
    }

    if (this.defaultRestorationPromise) {
      return this.defaultRestorationPromise;
    }

    if (!this.originalDefaultEndpoint || !this.originalDefaultEndpoint.id) {
      this.isDefaultRestored = true;
      return { restored: false, status: "NOT_REQUIRED", reason: "No original default endpoint recorded" };
    }

    this.defaultRestorationPromise = (async () => {
      console.log(`[DEFAULT-ENDPOINT] Restoring original default endpoint "${this.originalDefaultEndpoint.name}"...`);
      try {
        const res = await this._runAsync(["set-default-by-id", this.originalDefaultEndpoint.id]);
        if (res && res.success && res.verified) {
          console.log(`[DEFAULT-ENDPOINT] Restored "${this.originalDefaultEndpoint.name}" as Windows default output.`);
          this.isDefaultRestored = true;
          this.defaultSwitchedByDuoAudio = false;
          return { restored: true, status: "RESTORED", endpointId: this.originalDefaultEndpoint.id };
        } else {
          console.error(`[DEFAULT-ENDPOINT ERROR] Failed to restore original default endpoint:`, res?.error);
          return { restored: false, status: "FAILED", error: res?.error || "Verification failed", endpointId: this.originalDefaultEndpoint.id };
        }
      } catch (err) {
        console.error(`[DEFAULT-ENDPOINT ERROR] Restoration exception:`, err.message);
        return { restored: false, status: "FAILED", error: err.message, endpointId: this.originalDefaultEndpoint.id };
      }
    })();

    return this.defaultRestorationPromise;
  }

  /**
   * Synchronous emergency restoration of original default endpoint during process exit.
   */
  restoreDefaultEndpointSync() {
    if (!this.defaultSwitchedByDuoAudio || this.isDefaultRestored || !this.originalDefaultEndpoint || !this.originalDefaultEndpoint.id) {
      this.isDefaultRestored = true;
      return;
    }

    try {
      console.error(`[DEFAULT-ENDPOINT EMERGENCY] Restoring original default endpoint "${this.originalDefaultEndpoint.name}" synchronously...`);
      const raw = this._runSync(["set-default-by-id", this.originalDefaultEndpoint.id]);
      const res = JSON.parse(raw);
      if (res && res.success && res.verified) {
        console.error(`[DEFAULT-ENDPOINT EMERGENCY] Restoration complete.`);
      }
    } catch (e) {
      // Best-effort in emergency handler
    } finally {
      this.isDefaultRestored = true;
      this.defaultSwitchedByDuoAudio = false;
    }
  }

  /**
   * Restores both mute state and default endpoint state asynchronously.
   */
  async restoreAll() {
    const muteRes = await this.restore();
    const defaultRes = await this.restoreDefaultEndpoint();
    return { mute: muteRes, defaultEndpoint: defaultRes };
  }

  /**
   * Restores both mute state and default endpoint state synchronously on exit.
   */
  restoreAllSync() {
    this.restoreSync();
    this.restoreDefaultEndpointSync();
  }

  /**
   * Primary asynchronous execution dispatcher.
   * Invokes the native C++ helper executable directly.
   * @private
   */
  async _runAsync(args) {
    if (this._runNativeAsync !== EndpointMuteManager.prototype._runNativeAsync) {
      return this._runNativeAsync(args);
    }
    if (typeof this._runPsAsync === "function") {
      return this._runPsAsync(args);
    }

    const nativeExists = Boolean(this.nativePath && fs.existsSync(this.nativePath));
    if (!nativeExists) {
      throw new Error(`Native audio endpoint helper executable was not found at "${this.nativePath}".`);
    }

    return this._runNativeAsync(args);
  }

  /**
   * Asynchronous native child_process execution helper.
   * @private
   */
  _runNativeAsync(args) {
    return new Promise((resolve, reject) => {
      execFile(this.nativePath, args, { timeout: ENDPOINT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            const timeoutErr = new Error(`Native endpoint helper timed out after ${ENDPOINT_TIMEOUT_MS}ms`);
            timeoutErr.code = 'ETIMEDOUT';
            return reject(timeoutErr);
          }
          if (err.code === 'ENOENT' || err.code === 'EACCES') {
            return reject(err);
          }
        }

        const trimmed = (stdout || "").trim();
        if (!trimmed) {
          const spawnErr = new Error(`Native helper returned empty stdout. Exit code: ${err ? err.code : 0}. Stderr: ${stderr || "none"}`);
          if (err && err.code) spawnErr.code = err.code;
          return reject(spawnErr);
        }

        try {
          const parsed = JSON.parse(trimmed);
          resolve(parsed);
        } catch (parseErr) {
          const jsonErr = new Error(`Failed to parse native helper JSON response: "${trimmed}". Stderr: ${stderr || "none"}`);
          if (err && err.code) jsonErr.code = err.code;
          reject(jsonErr);
        }
      });
    });
  }

  /**
   * Primary synchronous execution dispatcher for emergency shutdown.
   * Invokes the native C++ helper executable directly.
   * @private
   */
  _runSync(args) {
    if (this._runNativeSync !== EndpointMuteManager.prototype._runNativeSync) {
      return this._runNativeSync(args);
    }
    if (typeof this._runPsSync === "function") {
      return this._runPsSync(args);
    }

    const nativeExists = Boolean(this.nativePath && fs.existsSync(this.nativePath));
    if (!nativeExists) {
      throw new Error(`Native audio endpoint helper executable was not found at "${this.nativePath}".`);
    }

    return this._runNativeSync(args);
  }

  /**
   * Synchronous native child_process execution helper.
   * @private
   */
  _runNativeSync(args) {
    try {
      const stdout = execFileSync(this.nativePath, args, {
        timeout: ENDPOINT_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true
      });
      return (stdout || "").trim();
    } catch (err) {
      if (err.stdout) {
        const trimmed = err.stdout.trim();
        if (trimmed) return trimmed;
      }
      throw err;
    }
  }

  /**
   * Emergency unmuting helper for a specific endpoint ID by invoking native helper.
   * Can be safely called from any process (including Electron main process).
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   * @param {Object} [options] - Optional manager options (e.g. custom nativePath)
   * @returns {Promise<{ restored: boolean, error?: string, reason?: string }>}
   */
  static async restoreEndpointById(endpointId, options = {}) {
    if (!endpointId || typeof endpointId !== "string") {
      return { restored: false, status: "FAILED", reason: "No valid endpointId provided", error: "No valid endpointId provided" };
    }
    const tempManager = new EndpointMuteManager(options);
    tempManager.targetEndpoint = { id: endpointId, name: endpointId };
    tempManager.isMutedByDuoAudio = true;
    tempManager.originallyMuted = false;
    return tempManager.restore();
  }

  /**
   * Synchronous emergency unmuting helper for a specific endpoint ID.
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   * @param {Object} [options] - Optional manager options
   */
  static restoreEndpointByIdSync(endpointId, options = {}) {
    if (!endpointId || typeof endpointId !== "string") return;
    const tempManager = new EndpointMuteManager(options);
    tempManager.targetEndpoint = { id: endpointId, name: endpointId };
    tempManager.isMutedByDuoAudio = true;
    tempManager.originallyMuted = false;
    tempManager.restoreSync();
  }

  /**
   * Emergency restoration of default endpoint by ID.
   * Can be safely called from any process (including Electron main process).
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   * @param {Object} [options] - Optional manager options
   * @returns {Promise<{ restored: boolean, error?: string, reason?: string }>}
   */
  static async restoreDefaultEndpointById(endpointId, options = {}) {
    if (!endpointId || typeof endpointId !== "string") {
      return { restored: false, status: "FAILED", reason: "No valid endpointId provided", error: "No valid endpointId provided" };
    }
    const tempManager = new EndpointMuteManager(options);
    tempManager.originalDefaultEndpoint = { id: endpointId, name: endpointId };
    tempManager.defaultSwitchedByDuoAudio = true;
    tempManager.isDefaultRestored = false;
    return tempManager.restoreDefaultEndpoint();
  }

  /**
   * Synchronous emergency restoration of default endpoint by ID.
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   * @param {Object} [options] - Optional manager options
   */
  static restoreDefaultEndpointByIdSync(endpointId, options = {}) {
    if (!endpointId || typeof endpointId !== "string") return;
    const tempManager = new EndpointMuteManager(options);
    tempManager.originalDefaultEndpoint = { id: endpointId, name: endpointId };
    tempManager.defaultSwitchedByDuoAudio = true;
    tempManager.isDefaultRestored = false;
    tempManager.restoreDefaultEndpointSync();
  }
}

module.exports = {
  EndpointMuteManager,
  resolveDefaultNativeHelperPath
};
