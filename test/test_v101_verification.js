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
console.log(' DuoAudio - Phase 8.1B Build Verification Suite');
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
check('package.json version is 1.0.1', pkg.version === '1.0.1', `(got: ${pkg.version})`);

// 2. Old artifacts preservation
const oldInstaller = path.join('dist', 'build', 'DuoAudio Setup 1.0.0.exe');
const oldUnpacked = path.join('dist', 'build', 'win-unpacked');
check('v1.0.0 installer exists', fs.existsSync(oldInstaller));
if (fs.existsSync(oldInstaller)) {
  const oldHash = getHash(oldInstaller);
  const oldSize = fs.statSync(oldInstaller).size;
  check(
    'v1.0.0 installer hash is unchanged',
    oldHash === 'A60E89E956A9CA35997B458599DA764BC267A6594FB1C1667F09814F804B5EFB',
    `(SHA256: ${oldHash}, size: ${oldSize} bytes)`
  );
}
check('v1.0.0 win-unpacked exists', fs.existsSync(oldUnpacked));

// 3. New v1.0.1 artifacts
const newInstaller = path.join('dist', 'releases', 'v1.0.1', 'DuoAudio Setup 1.0.1.exe');
const newUnpacked = path.join('dist', 'releases', 'v1.0.1', 'win-unpacked');
check('v1.0.1 installer exists', fs.existsSync(newInstaller));
let newHash = '';
let newSize = 0;
if (fs.existsSync(newInstaller)) {
  newHash = getHash(newInstaller);
  newSize = fs.statSync(newInstaller).size;
  console.log(`       [ARTIFACT] v1.0.1 Installer Size  : ${newSize} bytes (${(newSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`       [ARTIFACT] v1.0.1 Installer SHA256: ${newHash}`);
}
check('v1.0.1 win-unpacked exists', fs.existsSync(newUnpacked));

// 4. Required unpacked resources
const unpackedNode = path.join(newUnpacked, 'resources', 'runtime', 'node.exe');
const unpackedNative = path.join(newUnpacked, 'resources', 'bin', 'duoaudio_endpoint.exe');
const unpackedTelemetry = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'telemetry.js');
const unpackedRunner = path.join(newUnpacked, 'resources', 'app.asar.unpacked', 'src', 'audio_runner.js');
const unpackedExe = path.join(newUnpacked, 'DuoAudio.exe');

check('Bundled Node.js runtime included', fs.existsSync(unpackedNode), `(${fs.statSync(unpackedNode).size} bytes)`);
check('Native audio endpoint helper included', fs.existsSync(unpackedNative), `(${fs.statSync(unpackedNative).size} bytes)`);
check('Diagnostic telemetry module included in app.asar.unpacked', fs.existsSync(unpackedTelemetry), `(${fs.statSync(unpackedTelemetry).size} bytes)`);
check('Audio runner included in app.asar.unpacked', fs.existsSync(unpackedRunner), `(${fs.statSync(unpackedRunner).size} bytes)`);
check('DuoAudio.exe binary exists', fs.existsSync(unpackedExe));

// 5. Verify telemetry module loading in bundled Node runtime
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

// 6. Verify native helper execution via bundled Node / standalone
const nativeTest = spawnSync(unpackedNative, [], { encoding: 'utf8' });
check(
  'Native endpoint helper executes successfully in unpacked build',
  nativeTest.status === 1 && nativeTest.stdout.includes('No action specified'),
  `(Response: ${nativeTest.stdout.trim()})`
);

// 7. Verify unpacked application smoke test
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const appSmoke = spawnSync(unpackedExe, ['--smoke-test'], { env, encoding: 'utf8' });
check('Unpacked DuoAudio.exe passes --smoke-test', appSmoke.status === 0, `(Exit code: ${appSmoke.status})`);

console.log('\n===============================================================');
console.log(` Build Verification Summary: ${allPassed ? 'ALL PASSED' : 'FAILURES DETECTED'}`);
console.log('===============================================================\n');

if (!allPassed) process.exit(1);
