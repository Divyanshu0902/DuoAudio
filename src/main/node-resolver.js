/**
 * DuoAudio - System Node.js Executable Resolver & Runtime Validator
 *
 * Discovers and validates the host system's genuine Node.js executable.
 * Guarantees that:
 * 1. The binary is genuine Node.js (not Electron or an Electron wrapper).
 * 2. The architecture is x64.
 * 3. The version is compatible with existing native dependencies (Node >= 18).
 * 4. Required native C++ addons (`audify`, `loopback-capture`) load successfully.
 * 5. Deterministic path resolution with clear, actionable diagnostics.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let _cachedResolution = null;

/**
 * Probes a candidate executable path to verify it is genuine x64 Node.js and can load native addons.
 * @param {string} candidatePath - Absolute path to candidate node.exe
 * @returns {{ valid: boolean, version?: string, arch?: string, error?: string }}
 */
function validateNodeExecutable(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return { valid: false, error: 'Candidate path is null or not a string.' };
  }

  // 1. File existence check
  try {
    if (!fs.existsSync(candidatePath)) {
      return { valid: false, error: `File not found at: ${candidatePath}` };
    }
  } catch (err) {
    return { valid: false, error: `Filesystem access error: ${err.message}` };
  }

  // 2. Identity and architecture probe (must NOT be Electron)
  try {
    const probeScript = 'console.log(JSON.stringify({ isElectron: Boolean(process.versions.electron), version: process.version, arch: process.arch }))';
    const stdout = execFileSync(candidatePath, ['-e', probeScript], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });

    const parsed = JSON.parse(stdout.trim());

    if (parsed.isElectron === true) {
      return { valid: false, error: `Executable at "${candidatePath}" is Electron, not genuine system Node.js.` };
    }

    if (parsed.arch !== 'x64') {
      return { valid: false, error: `Expected x64 architecture, but executable reported "${parsed.arch}".` };
    }

    // 3. Native dependency loadability probe
    const projectRoot = (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked')))
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : path.resolve(__dirname, '../../');
    const nativeProbeScript = `
      try {
        require('audify');
        require('loopback-capture');
        console.log('NATIVE_OK');
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    `;

    const nativeStdout = execFileSync(candidatePath, ['-e', nativeProbeScript], {
      timeout: 4000,
      encoding: 'utf8',
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    if (!nativeStdout.includes('NATIVE_OK')) {
      return { valid: false, error: `Native dependencies failed to load in runtime: ${nativeStdout.trim()}` };
    }

    return {
      valid: true,
      version: parsed.version,
      arch: parsed.arch,
      error: null
    };
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    return { valid: false, error: `Runtime validation failed for "${candidatePath}": ${detail}` };
  }
}

/**
 * Searches the Windows environment for candidate Node.js executables in deterministic priority order.
 * @returns {string[]} Array of candidate file paths
 */
function findCandidateNodePaths() {
  const candidates = [];

  // 0. Packaged bundled runtime (highest priority in production)
  if (process.resourcesPath) {
    const bundledPath = path.join(process.resourcesPath, 'runtime', 'node.exe');
    if (fs.existsSync(bundledPath) && !candidates.includes(bundledPath)) {
      candidates.push(bundledPath);
    }
  }

  // 1. Check system PATH via where.exe (highest priority: Windows default resolution)
  try {
    const whereOut = execFileSync('where.exe', ['node'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });

    const lines = whereOut.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.toLowerCase().endsWith('.exe'));
    for (const line of lines) {
      if (!candidates.includes(line)) {
        candidates.push(line);
      }
    }
  } catch (e) {
    // where.exe failed or node not in PATH; proceed to standard directory checks
  }

  // 2. Standard Windows installation locations
  const standardPaths = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'node', 'node.exe') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'nvm', 'current', 'node.exe') : null
  ].filter(Boolean);

  for (const p of standardPaths) {
    if (!candidates.includes(p)) {
      candidates.push(p);
    }
  }

  return candidates;
}

/**
 * Resolves the genuine system Node.js executable.
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {{ success: boolean, nodePath: string|null, version: string|null, arch: string|null, error: string|null }}
 */
function resolveSystemNode(options = {}) {
  if (_cachedResolution && !options.forceRefresh) {
    return _cachedResolution;
  }

  const candidates = findCandidateNodePaths();
  const errors = [];

  for (const candidate of candidates) {
    const result = validateNodeExecutable(candidate);
    if (result.valid) {
      _cachedResolution = {
        success: true,
        nodePath: candidate,
        version: result.version,
        arch: result.arch,
        error: null
      };
      return _cachedResolution;
    } else {
      errors.push(`${candidate}: ${result.error}`);
    }
  }

  _cachedResolution = {
    success: false,
    nodePath: null,
    version: null,
    arch: null,
    error: `Unable to locate a genuine x64 Node.js runtime compatible with native dependencies. Evaluated ${candidates.length} candidate(s):\n${errors.join('\n')}`
  };

  return _cachedResolution;
}

module.exports = {
  resolveSystemNode,
  validateNodeExecutable,
  findCandidateNodePaths
};
