/**
 * DuoAudio - Phase 4C.1: Windows Core Audio Endpoint Mute Manager
 *
 * Automatically mutes the active Windows default playback endpoint at routing
 * startup to ensure physical speakers remain silent in the room while dual
 * Bluetooth earbuds receive audio, and reliably restores the original mute
 * state upon coordinated shutdown.
 *
 * Implements:
 * - Dynamic default endpoint resolution and friendly name extraction.
 * - Idempotent asynchronous and synchronous restoration hooks.
 * - Preservation of pre-session muted state (never un-mutes an already muted device).
 * - Targeted restoration by device GUID (immune to default device changes mid-session).
 * - Safe handling of disconnected endpoints.
 * - Zero external npm dependencies (uses native Windows Core Audio COM via PowerShell bridge).
 */

const path = require("path");
const { execFile, execFileSync } = require("child_process");

const SCRIPT_PATH = path.resolve(
  __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'),
  'audio_endpoint.ps1'
);
const POWERSHELL_TIMEOUT_MS = 5000;

class EndpointMuteManager {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true] - Set false (via --no-mute) to disable automatic muting
   * @param {string} [options.scriptPath] - Custom script path override
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.scriptPath = options.scriptPath || SCRIPT_PATH;

    this.targetEndpoint = null; // { id, name, isMuted, volume }
    this.originallyMuted = null;
    this.isMutedByDuoAudio = false;
    this.isRestored = false;
    this.restorationPromise = null;
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
      queryResult = await this._runPsAsync(["query-default"]);
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
      muteResult = await this._runPsAsync(["mute-by-id", this.targetEndpoint.id]);
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

    // If DuoAudio never muted the device or it was already muted before starting, do not unmute
    if (!this.isMutedByDuoAudio || this.originallyMuted === true) {
      this.isRestored = true;
      if (this.originallyMuted === true && this.targetEndpoint) {
        console.log(`[MUTE] Preserved original muted state for "${this.targetEndpoint.name}".`);
      }
      return { restored: false, status: "NOT_REQUIRED", reason: "Preserved original pre-session mute state", endpointId: this.targetEndpoint?.id };
    }

    this.restorationPromise = (async () => {
      console.log(`[MUTE] Restoring original unmuted state for "${this.targetEndpoint.name}"...`);
      try {
        const res = await this._runPsAsync(["unmute-by-id", this.targetEndpoint.id]);
        if (res.success) {
          console.log(`[MUTE] Restored "${this.targetEndpoint.name}" to unmuted state.`);
          this.isRestored = true;
          this.isMutedByDuoAudio = false;
          return { restored: true, status: "RESTORED", endpointId: this.targetEndpoint.id };
        } else {
          // Check for disconnected device (0x80070490)
          if ((res.error || "").includes("0x80070490") || (res.error || "").includes("not found")) {
            console.warn(`[MUTE NOTICE] Muted endpoint was disconnected; restoration skipped safely.`);
            this.isRestored = true;
            this.isMutedByDuoAudio = false;
            return { restored: false, status: "SKIPPED", reason: "Endpoint disconnected", endpointId: this.targetEndpoint.id };
          }
          console.error(`[MUTE ERROR] Failed to unmute "${this.targetEndpoint.name}":`, res.error);
          return { restored: false, status: "FAILED", error: res.error, endpointId: this.targetEndpoint.id };
        }
      } catch (err) {
        console.error(`[MUTE ERROR] PowerShell restoration error:`, err.message);
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
    if (!this.enabled || this.isRestored || !this.isMutedByDuoAudio || this.originallyMuted === true || !this.targetEndpoint) {
      this.isRestored = true;
      return;
    }

    try {
      console.error(`[MUTE EMERGENCY] Restoring unmuted state on "${this.targetEndpoint.name}" synchronously...`);
      const raw = this._runPsSync(["unmute-by-id", this.targetEndpoint.id]);
      const res = JSON.parse(raw);
      if (res.success) {
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
   * Asynchronous child_process execution helper.
   * @private
   */
  _runPsAsync(args) {
    return new Promise((resolve, reject) => {
      const psArgs = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.scriptPath,
        ...args
      ];

      execFile("powershell.exe", psArgs, { timeout: POWERSHELL_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            return reject(new Error(`PowerShell process timed out after ${POWERSHELL_TIMEOUT_MS}ms`));
          }
          return reject(new Error(`PowerShell launch error: ${err.message}`));
        }

        const trimmed = (stdout || "").trim();
        if (!trimmed) {
          return reject(new Error(`PowerShell returned empty stdout. Stderr: ${stderr || "none"}`));
        }

        try {
          const parsed = JSON.parse(trimmed);
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`Failed to parse PowerShell JSON response: "${trimmed}". Stderr: ${stderr || "none"}`));
        }
      });
    });
  }

  /**
   * Synchronous child_process execution helper.
   * @private
   */
  _runPsSync(args) {
    const psArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      ...args
    ];

    const stdout = execFileSync("powershell.exe", psArgs, {
      timeout: POWERSHELL_TIMEOUT_MS,
      encoding: "utf8"
    });

    return (stdout || "").trim();
  }

  /**
   * Emergency unmuting helper for a specific endpoint ID by invoking PowerShell.
   * Can be safely called from any process (including Electron main process).
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   * @returns {Promise<{ restored: boolean, error?: string, reason?: string }>}
   */
  static async restoreEndpointById(endpointId) {
    if (!endpointId || typeof endpointId !== "string") {
      return { restored: false, status: "FAILED", reason: "No valid endpointId provided", error: "No valid endpointId provided" };
    }
    const tempManager = new EndpointMuteManager();
    tempManager.targetEndpoint = { id: endpointId, name: endpointId };
    tempManager.isMutedByDuoAudio = true;
    tempManager.originallyMuted = false;
    return tempManager.restore();
  }

  /**
   * Synchronous emergency unmuting helper for a specific endpoint ID.
   * @param {string} endpointId - Direct Windows endpoint ID GUID
   */
  static restoreEndpointByIdSync(endpointId) {
    if (!endpointId || typeof endpointId !== "string") return;
    const tempManager = new EndpointMuteManager();
    tempManager.targetEndpoint = { id: endpointId, name: endpointId };
    tempManager.isMutedByDuoAudio = true;
    tempManager.originallyMuted = false;
    tempManager.restoreSync();
  }
}

module.exports = {
  EndpointMuteManager
};
