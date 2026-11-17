/**
 * DuoAudio - Packaged Runtime & Module Loadability Verification
 *
 * Verifies:
 * 1. Bundled node.exe runs independently.
 * 2. Bundled node.exe loads audify.node and loopback_capture_addon.node from app.asar.unpacked.
 * 3. Enumerate worker runs under bundled node.exe and returns valid JSON device descriptors.
 * 4. PowerShell endpoint mute script is accessible and executable from app.asar.unpacked.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

console.log('======================================================');
console.log(' DuoAudio - Packaged Runtime & Addon Verification      ');
console.log('======================================================\n');

const candidateDirs = [
  path.resolve(__dirname, '../dist/releases/v1.0.2/win-unpacked'),
  path.resolve(__dirname, '../dist/releases/v1.0.1/win-unpacked'),
  path.resolve(__dirname, '../dist/build/win-unpacked')
];
const baseDir = candidateDirs.find(d => fs.existsSync(d)) || candidateDirs[0];
const pkgNode = path.join(baseDir, 'resources/runtime/node.exe');
const unpackedDir = path.join(baseDir, 'resources/app.asar.unpacked');
const workerScript = path.join(unpackedDir, 'src/main/enumerate-worker.js');
const nativeHelper = path.join(baseDir, 'resources/bin/duoaudio_endpoint.exe');

// 1. Verify existence
console.log('Step 1: Checking packaged paths...');
assert.ok(fs.existsSync(pkgNode), `Bundled Node.exe must exist at ${pkgNode}`);
assert.ok(fs.existsSync(unpackedDir), `app.asar.unpacked must exist at ${unpackedDir}`);
assert.ok(fs.existsSync(workerScript), `enumerate-worker.js must exist at ${workerScript}`);
assert.ok(fs.existsSync(nativeHelper), `duoaudio_endpoint.exe must exist at ${nativeHelper}`);
console.log('  [+] All packaged target files exist.\n');

// 2. Verify bundled Node version & arch
console.log('Step 2: Probing bundled Node.js runtime...');
const nodeOut = execFileSync(pkgNode, ['-e', 'console.log(process.version, process.arch)'], { encoding: 'utf8' }).trim();
console.log(`  [+] Bundled Node output: ${nodeOut}`);
assert.strictEqual(nodeOut, 'v22.19.0 x64');

// 3. Verify native addon loading from app.asar.unpacked
console.log('\nStep 3: Loading native addons from app.asar.unpacked using bundled Node...');
const loadCode = [
  "const audify = require('audify');",
  "const loopback = require('loopback-capture');",
  "console.log('RtAudio devices count:', new audify.RtAudio(audify.RtAudioApi.WINDOWS_WASAPI).getDevices().length);",
  "console.log('Loopback addon loaded successfully.');"
].join('\n');

const loadOut = execFileSync(pkgNode, ['-e', loadCode], {
  cwd: unpackedDir,
  encoding: 'utf8',
  timeout: 5000
}).trim();
console.log(loadOut);
console.log('  [+] Native addons loaded into bundled Node.js without ABI errors!\n');

// 4. Verify enumeration worker execution under bundled Node
console.log('Step 4: Executing packaged enumeration worker...');
const workerOut = execFileSync(pkgNode, [workerScript], {
  cwd: path.dirname(workerScript),
  encoding: 'utf8',
  timeout: 5000
}).trim();

const parsedWorker = JSON.parse(workerOut);
assert.strictEqual(parsedWorker.success, true);
assert.ok(Array.isArray(parsedWorker.devices));
console.log(`  [+] Worker returned ${parsedWorker.devices.length} playback device(s):`);
for (const dev of parsedWorker.devices) {
  console.log(`      - ID ${dev.id}: "${dev.name}" (default=${dev.isDefault})`);
}

// 5. Verify Native Helper execution from resources/bin
console.log('\nStep 5: Querying default playback endpoint using packaged duoaudio_endpoint.exe...');
const helperOut = execFileSync(nativeHelper, ['query-default'], { encoding: 'utf8', timeout: 5000 }).trim();

const parsedHelper = JSON.parse(helperOut);
assert.strictEqual(parsedHelper.success, true);
console.log(`  [+] Native helper query succeeded: "${parsedHelper.name}" (muted=${parsedHelper.isMuted})`);

console.log('\n======================================================');
console.log(' All Packaged Runtime & Addon Checks PASSED!          ');
console.log('======================================================');
