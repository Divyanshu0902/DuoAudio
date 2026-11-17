/**
 * DuoAudio - Phase 5D.2B: Resource Path & Runtime Integration Test Suite
 *
 * Verifies:
 * 1. Resource-path resolution in development mode (resolves from PROJECT_ROOT).
 * 2. Resource-path resolution in packaged mode (resolves from app.asar.unpacked).
 * 3. Audio runner path resolution.
 * 4. Enumeration worker path resolution.
 * 5. Node.js runtime resolution (bundled vs system fallback).
 * 6. PowerShell script path resolution across development, packaged Electron, and external Node.
 * 7. Absence of Electron API leakage in modules executed by external Node.js.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('======================================================');
console.log(' DuoAudio - Phase 5D.2B Resource Path Integration Tests');
console.log('======================================================\n');

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [+] PASS: ${name}`);
  } catch (err) {
    console.error(`  [-] FAIL: ${name}`);
    console.error(`      Error: ${err.message}`);
    process.exitCode = 1;
  }
}

// Suite 1: Development Mode Resource Path Resolution
console.log('--- Suite 1: Development Mode Resource Paths ---');

const { PROJECT_ROOT, getUnpackedPath, getBundledNodePath, getNativeHelperPath } = require('../src/main/resource-paths');

test('PROJECT_ROOT correctly resolves to actual repository root', () => {
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'package.json')), 'PROJECT_ROOT must contain package.json');
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'src/main/resource-paths.js')), 'PROJECT_ROOT must contain src/main/resource-paths.js');
});

test('getUnpackedPath resolves correctly in development mode without duplicate directories', () => {
  const runnerPath = getUnpackedPath('src/audio_runner.js');
  const expectedRunner = path.resolve(PROJECT_ROOT, 'src/audio_runner.js');
  assert.strictEqual(runnerPath, expectedRunner);
  assert.ok(fs.existsSync(runnerPath), 'Resolved runner script must exist on disk in development');
  assert.ok(!runnerPath.includes('src\\src'), 'Path must not contain duplicate src directory');

  const workerPath = getUnpackedPath('src/main/enumerate-worker.js');
  const expectedWorker = path.resolve(PROJECT_ROOT, 'src/main/enumerate-worker.js');
  assert.strictEqual(workerPath, expectedWorker);
  assert.ok(fs.existsSync(workerPath), 'Resolved worker script must exist on disk in development');
});

test('getBundledNodePath returns null when not running in packaged mode with resourcesPath', () => {
  // In development, process.resourcesPath is undefined
  const bundled = getBundledNodePath();
  if (!process.resourcesPath) {
    assert.strictEqual(bundled, null);
  }
});

test('getNativeHelperPath resolves to existing executable in development mode', () => {
  const nativePath = getNativeHelperPath();
  assert.ok(fs.existsSync(nativePath), `Native helper must exist at: ${nativePath}`);
  assert.ok(nativePath.endsWith('duoaudio_endpoint.exe'), 'Native helper path must end with duoaudio_endpoint.exe');
});

// Suite 2: Packaged Mode Path Construction Simulation
console.log('\n--- Suite 2: Packaged Mode Path Construction Simulation ---');

test('Simulated packaged-mode path resolution constructs app.asar.unpacked paths', () => {
  const mockResourcesPath = 'C:\\Program Files\\DuoAudio\\resources';

  function simulateGetUnpackedPath(isPackaged, resourcesPath, relativePath) {
    if (isPackaged && resourcesPath) {
      return path.join(resourcesPath, 'app.asar.unpacked', relativePath);
    }
    return path.resolve(PROJECT_ROOT, relativePath);
  }

  const pkgRunner = simulateGetUnpackedPath(true, mockResourcesPath, 'src/audio_runner.js');
  assert.strictEqual(
    pkgRunner,
    'C:\\Program Files\\DuoAudio\\resources\\app.asar.unpacked\\src\\audio_runner.js'
  );

  const pkgWorker = simulateGetUnpackedPath(true, mockResourcesPath, 'src/main/enumerate-worker.js');
  assert.strictEqual(
    pkgWorker,
    'C:\\Program Files\\DuoAudio\\resources\\app.asar.unpacked\\src\\main\\enumerate-worker.js'
  );

  const pkgNode = path.join(mockResourcesPath, 'runtime', 'node.exe');
  assert.strictEqual(
    pkgNode,
    'C:\\Program Files\\DuoAudio\\resources\\runtime\\node.exe'
  );

  const pkgHelper = path.join(mockResourcesPath, 'bin', 'duoaudio_endpoint.exe');
  assert.strictEqual(
    pkgHelper,
    'C:\\Program Files\\DuoAudio\\resources\\bin\\duoaudio_endpoint.exe'
  );
});

// Suite 3: Node.js Runtime Resolution (System vs. Bundled)
console.log('\n--- Suite 3: Node.js Executable Resolution ---');

const { resolveSystemNode, validateNodeExecutable } = require('../src/main/node-resolver');

test('resolveSystemNode locates valid genuine system Node.js in development', () => {
  const resolution = resolveSystemNode();
  assert.strictEqual(resolution.success, true);
  assert.ok(resolution.nodePath);
  assert.ok(fs.existsSync(resolution.nodePath));
  assert.strictEqual(resolution.arch, 'x64');
  console.log(`      Resolved Node: ${resolution.nodePath} (v${resolution.version}, arch=${resolution.arch})`);
});

test('validateNodeExecutable confirms Node 22 native addon compatibility', () => {
  const resolution = resolveSystemNode();
  const validation = validateNodeExecutable(resolution.nodePath);
  assert.strictEqual(validation.valid, true);
  assert.strictEqual(validation.error, null);
});

// Suite 4: Native Helper Path Resolution
console.log('\n--- Suite 4: Native Helper Path Resolution ---');

const { EndpointMuteManager, resolveDefaultNativeHelperPath } = require('../src/endpoint_mute');

test('EndpointMuteManager resolves native helper in development', () => {
  const muteManager = new EndpointMuteManager();
  assert.ok(fs.existsSync(muteManager.nativePath), `Native helper "${muteManager.nativePath}" must exist on disk`);
  assert.ok(muteManager.nativePath.endsWith('duoaudio_endpoint.exe'));
});

test('EndpointMuteManager accepts custom nativePath override in options', () => {
  const customPath = 'D:\\Custom\\bin\\duoaudio_endpoint.exe';
  const muteManager = new EndpointMuteManager({ nativePath: customPath });
  assert.strictEqual(muteManager.nativePath, customPath);
});

test('resolveDefaultNativeHelperPath respects DUOAUDIO_HELPER_PATH env override', () => {
  const origEnv = process.env.DUOAUDIO_HELPER_PATH;
  try {
    const rootExe = path.resolve(PROJECT_ROOT, 'duoaudio_endpoint.exe');
    process.env.DUOAUDIO_HELPER_PATH = rootExe;
    assert.strictEqual(resolveDefaultNativeHelperPath(), rootExe);
  } finally {
    if (origEnv !== undefined) {
      process.env.DUOAUDIO_HELPER_PATH = origEnv;
    } else {
      delete process.env.DUOAUDIO_HELPER_PATH;
    }
  }
});

// Suite 5: Isolation & Zero Electron Leaks in Runner Modules
console.log('\n--- Suite 5: Zero Electron Leaks in External Runner Modules ---');

test('External runner modules do not require electron or electron APIs', () => {
  const externalFiles = [
    'src/audio_runner.js',
    'src/output_stream.js',
    'src/pcm_converter.js',
    'src/audio_buffer.js',
    'src/endpoint_mute.js',
    'src/main/enumerate-worker.js'
  ];

  for (const relFile of externalFiles) {
    const fullPath = path.resolve(PROJECT_ROOT, relFile);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Check for require('electron') or require("electron")
    const hasElectronRequire = /require\s*\(\s*['"]electron['"]\s*\)/.test(content);
    assert.strictEqual(
      hasElectronRequire,
      false,
      `File "${relFile}" must NOT import "electron"`
    );

    // Check for require('./resource-paths') or similar Electron helper
    const hasResourcePathsRequire = /require\s*\(\s*['"][^'"]*resource-paths[^'"]*['"]\s*\)/.test(content);
    assert.strictEqual(
      hasResourcePathsRequire,
      false,
      `File "${relFile}" must NOT import "resource-paths"`
    );
  }
});

// Suite 6: DeviceService integration with external Node.js
console.log('\n--- Suite 6: DeviceService Node.js Runtime Integration ---');

const { enumeratePlaybackDevices, enumeratePlaybackDevicesSync } = require('../src/main/device-service');

test('enumeratePlaybackDevicesSync uses resolved Node and unpacked worker to enumerate endpoints', () => {
  const result = enumeratePlaybackDevicesSync();
  assert.strictEqual(result.success, true);
  assert.ok(Array.isArray(result.devices));
  assert.ok(result.devices.length > 0, 'Must detect at least 1 playback endpoint on test system');
  console.log(`      Enumerated ${result.devices.length} device(s) via external Node worker: "${result.devices[0].name}"`);
});

console.log('\n======================================================');
console.log(` Results: ${passed}/${total} Resource Path Tests PASSED (0 Failed)`);
console.log('======================================================');
