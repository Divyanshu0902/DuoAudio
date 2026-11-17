const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function getHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex').toUpperCase();
}

console.log('===============================================================');
console.log(' DuoAudio - Release v1.0.2 Build Verification Suite');
console.log('===============================================================\n');

let allPassed = true;
function check(description, condition, details = '') {
  if (condition) {
    console.log(`  [+] PASS: ${description} ${details}`);
  } else {
    console.error(`  [-] FAIL: ${description} ${details}`);
    allPassed = false;
  }
}

// 1. Version in package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
check('package.json version is 1.0.2', pkg.version === '1.0.2', `(got: ${pkg.version})`);

// 2. Old artifacts preservation
const oldInstallerV100 = path.join('dist', 'build', 'DuoAudio Setup 1.0.0.exe');
const oldUnpackedV100 = path.join('dist', 'build', 'win-unpacked');
check('v1.0.0 installer exists', fs.existsSync(oldInstallerV100));
check('v1.0.0 win-unpacked exists', fs.existsSync(oldUnpackedV100));

const oldInstallerV101 = path.join('dist', 'releases', 'v1.0.1', 'DuoAudio Setup 1.0.1.exe');
const oldUnpackedV101 = path.join('dist', 'releases', 'v1.0.1', 'win-unpacked');
check('v1.0.1 installer exists', fs.existsSync(oldInstallerV101));
check('v1.0.1 win-unpacked exists', fs.existsSync(oldUnpackedV101));

// 3. New v1.0.2 artifacts
const newInstaller = path.join('dist', 'releases', 'v1.0.2', 'DuoAudio Setup 1.0.2.exe');
const newUnpacked = path.join('dist', 'releases', 'v1.0.2', 'win-unpacked');
check('v1.0.2 installer exists', fs.existsSync(newInstaller));

let newHash = '';
let newSize = 0;
if (fs.existsSync(newInstaller)) {
  newHash = getHash(newInstaller);
  newSize = fs.statSync(newInstaller).size;
  console.log(`       [ARTIFACT] v1.0.2 Installer Size  : ${newSize} bytes (${(newSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`       [ARTIFACT] v1.0.2 Installer SHA256: ${newHash}`);
}
check('v1.0.2 win-unpacked exists', fs.existsSync(newUnpacked));

// 4. Required unpacked resources
const unpackedNode = path.join(newUnpacked, 'resources', 'runtime', 'node.exe');
const unpackedNative = path.join(newUnpacked, 'resources', 'bin', 'duoaudio_endpoint.exe');
const unpackedTelemetry = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'telemetry.js');
const unpackedRunner = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'audio_runner.js');
const unpackedMute = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'endpoint_mute.js');
const unpackedPs1 = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'audio_endpoint.ps1');
const unpackedExe = path.join(newUnpacked, 'DuoAudio.exe');

check('Bundled Node.js runtime included', fs.existsSync(unpackedNode), `(${fs.existsSync(unpackedNode) ? fs.statSync(unpackedNode).size : 0} bytes)`);
check('Native audio endpoint helper included', fs.existsSync(unpackedNative), `(${fs.existsSync(unpackedNative) ? fs.statSync(unpackedNative).size : 0} bytes)`);
check('Diagnostic telemetry module included in app.asar.unpacked', fs.existsSync(unpackedTelemetry));
check('Audio runner included in app.asar.unpacked', fs.existsSync(unpackedRunner));
check('Endpoint mute manager included in app.asar.unpacked', fs.existsSync(unpackedMute));
check('NO audio_endpoint.ps1 bundled anywhere in unpacked package', !fs.existsSync(unpackedPs1));
check('DuoAudio.exe binary exists', fs.existsSync(unpackedExe));

// 5. Verify telemetry module loading in bundled Node runtime
if (fs.existsSync(unpackedNode) && fs.existsSync(unpackedTelemetry)) {
  const nodeTest = spawnSync(unpackedNode, [
    '-e',
    'const t = require("./" + process.argv[1]); console.log(Object.keys(t).join(","));',
    unpackedTelemetry
  ], { encoding: 'utf8' });

  check(
    'Telemetry module loads cleanly in bundled Node 22 runtime',
    nodeTest.status === 0 && nodeTest.stdout.includes('OutputStreamTelemetry'),
    `(Exports: ${nodeTest.stdout.trim() || nodeTest.stderr.trim()})`
  );
}

// 6. Verify native helper execution via standalone binary in release
if (fs.existsSync(unpackedNative)) {
  const nativeTest = spawnSync(unpackedNative, ['list-endpoints'], { encoding: 'utf8' });
  let hasValidJson = false;
  try {
    const parsed = JSON.parse(nativeTest.stdout.trim());
    hasValidJson = parsed.success === true && Array.isArray(parsed.devices);
  } catch (e) {}

  check(
    'Native endpoint helper executes successfully and lists endpoints',
    nativeTest.status === 0 && hasValidJson,
    `(Response: ${nativeTest.stdout.trim().slice(0, 100)}...)`
  );
}

// 7. Verify unpacked application smoke test
if (fs.existsSync(unpackedExe)) {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const appSmoke = spawnSync(unpackedExe, ['--smoke-test'], { env, encoding: 'utf8' });
  check('Unpacked DuoAudio.exe passes --smoke-test', appSmoke.status === 0, `(Exit code: ${appSmoke.status})`);
}

console.log('\n===============================================================');
console.log(` Build Verification Summary: ${allPassed ? 'ALL PASSED' : 'FAILURES DETECTED'}`);
console.log('===============================================================\n');

if (!allPassed) process.exit(1);
