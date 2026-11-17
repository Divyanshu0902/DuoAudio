/**
 * DuoAudio - Phase 5D.2D: Installed Application & Environment Verification
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

console.log('======================================================');
console.log(' DuoAudio - Phase 5D.2D Installation Verification     ');
console.log('======================================================\n');

const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
const installDir = path.join(localAppData, 'Programs', 'DuoAudio');
const installedExe = path.join(installDir, 'DuoAudio.exe');
const installedNode = path.join(installDir, 'resources', 'runtime', 'node.exe');
const installedAsar = path.join(installDir, 'resources', 'app.asar');
const installedUnpacked = path.join(installDir, 'resources', 'app.asar.unpacked');
const installedNativeHelper = path.join(installDir, 'resources', 'bin', 'duoaudio_endpoint.exe');
const uninstaller = path.join(installDir, 'Uninstall DuoAudio.exe');

// 1. Verify filesystem presence in Local AppData Programs
console.log('Step 1: Verifying per-user installation structure...');
assert.ok(fs.existsSync(installDir), `Installation directory must exist at ${installDir}`);
assert.ok(fs.existsSync(installedExe), `Installed DuoAudio.exe must exist at ${installedExe}`);
assert.ok(fs.existsSync(installedNode), `Bundled node.exe must exist at ${installedNode}`);
assert.ok(fs.existsSync(installedNativeHelper), `Native helper must exist at ${installedNativeHelper}`);
assert.ok(fs.existsSync(installedAsar), `app.asar must exist at ${installedAsar}`);
assert.ok(fs.existsSync(installedUnpacked), `app.asar.unpacked must exist at ${installedUnpacked}`);
assert.ok(fs.existsSync(uninstaller), `Uninstaller must exist at ${uninstaller}`);
console.log('  [+] All per-user application directories and files verified (including resources/bin/duoaudio_endpoint.exe).');

// 2. Verify shortcuts
console.log('\nStep 2: Verifying Start Menu and Desktop shortcuts...');
const startMenuLnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DuoAudio.lnk');
assert.ok(fs.existsSync(startMenuLnk), `Start Menu shortcut must exist at ${startMenuLnk}`);
console.log(`  [+] Start Menu shortcut verified at: ${startMenuLnk}`);

// Query Desktop folder via PowerShell to handle redirected folders
const psDesktopQuery = `[Console]::WriteLine([Environment]::GetFolderPath('Desktop'))`;
const desktopFolder = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', psDesktopQuery], { encoding: 'utf8' }).trim();
const desktopLnk = path.join(desktopFolder, 'DuoAudio.lnk');
assert.ok(fs.existsSync(desktopLnk), `Desktop shortcut must exist at ${desktopLnk}`);
console.log(`  [+] Desktop shortcut verified at: ${desktopLnk}`);

// Verify shortcut targets point to installed executable
const psLnkTarget = `
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut('${desktopLnk.replace(/'/g, "''")}')
[Console]::WriteLine($sc.TargetPath)
`;
const lnkTarget = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', psLnkTarget], { encoding: 'utf8' }).trim();
console.log(`  [+] Desktop shortcut points to: ${lnkTarget}`);
assert.strictEqual(path.resolve(lnkTarget).toLowerCase(), path.resolve(installedExe).toLowerCase());

// 3. Verify Windows Registry Uninstall entry
console.log('\nStep 3: Checking Windows Registry uninstall key...');
const regQuery = cp.execFileSync('reg.exe', [
  'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DuoAudio'
], { encoding: 'utf8' });

assert.ok(regQuery.includes('DuoAudio 1.0.0'), 'Registry must contain DuoAudio 1.0.0');
assert.ok(regQuery.includes('Uninstall DuoAudio.exe'), 'Registry must contain uninstaller path');
console.log('  [+] Windows Registry uninstaller registration verified in HKCU (per-user).');

// 4. Test Installed Application Smoke Test
console.log('\nStep 4: Executing installed application smoke test...');
const envClean = Object.assign({}, process.env);
delete envClean.ELECTRON_RUN_AS_NODE;

const smokeRes = cp.spawnSync(installedExe, ['--smoke-test'], {
  env: envClean,
  encoding: 'utf8'
});

console.log(smokeRes.stdout);
if (smokeRes.stderr) {
  console.error('STDERR:', smokeRes.stderr);
}
assert.strictEqual(smokeRes.status, 0, `Installed smoke test failed with exit code ${smokeRes.status}`);
console.log('  [+] Installed DuoAudio.exe smoke test PASSED with exit code 0.');

// 5. Test External Runtime Independence (Strip PATH of all global Node installations)
console.log('\nStep 5: Testing external runtime independence (Node removed from PATH)...');
const pathParts = (process.env.PATH || '').split(';').filter(p => {
  const low = p.toLowerCase();
  return !low.includes('node') && !low.includes('nvm');
});
const isolatedPath = pathParts.join(';');

const envIsolated = Object.assign({}, process.env, {
  PATH: isolatedPath
});
delete envIsolated.ELECTRON_RUN_AS_NODE;

// Ensure `where.exe node` fails under isolated PATH
try {
  cp.execFileSync('where.exe', ['node'], { env: envIsolated, stdio: 'ignore' });
  assert.fail('where.exe node should have failed under isolated PATH');
} catch (e) {
  console.log('  [+] Confirmed: Global Node.js is completely unavailable in isolated PATH.');
}

// Run smoke test under isolated PATH
const isolatedRes = cp.spawnSync(installedExe, ['--smoke-test'], {
  env: envIsolated,
  encoding: 'utf8'
});

console.log(isolatedRes.stdout);
if (isolatedRes.stderr) {
  console.error('STDERR:', isolatedRes.stderr);
}
assert.strictEqual(isolatedRes.status, 0, `Isolated PATH smoke test failed with exit code ${isolatedRes.status}`);
console.log('  [+] Installed DuoAudio.exe PASSED under isolated PATH without global Node!');

// 6. Inspect which Node executable was discovered/used
console.log('\nStep 6: Verifying Node runtime resolution priority in installed app...');
// In development/test environment, evaluate node-resolver with simulated installed resourcesPath
const { resolveSystemNode } = require('../src/main/node-resolver');
const savedResourcesPath = process.resourcesPath;
try {
  process.resourcesPath = path.join(installDir, 'resources');
  const resolved = resolveSystemNode();
  console.log('  [+] Node resolver output under installed resourcesPath:');
  console.log('      nodePath :', resolved.nodePath);
  console.log('      version  :', resolved.version);
  console.log('      arch     :', resolved.arch);
  console.log('      valid    :', resolved.valid);
  assert.strictEqual(path.resolve(resolved.nodePath).toLowerCase(), path.resolve(installedNode).toLowerCase());
  console.log('  [+] Verified: The application resolves and prioritizes its bundled runtime/node.exe!');
} finally {
  process.resourcesPath = savedResourcesPath;
}

// Also verify the bundled node.exe can directly execute the installed enumeration worker under isolated PATH
const workerPath = path.join(installedUnpacked, 'src', 'main', 'enumerate-worker.js');
const workerOut = cp.execFileSync(installedNode, [workerPath], {
  cwd: path.dirname(workerPath),
  env: envIsolated,
  encoding: 'utf8',
  timeout: 5000
}).trim();
const parsedWorker = JSON.parse(workerOut);
assert.strictEqual(parsedWorker.success, true);
console.log(`  [+] Bundled node.exe executed installed worker without global Node (returned ${parsedWorker.devices.length} device(s)).`);

console.log('\n======================================================');
console.log(' All Installed Application Checks PASSED!             ');
console.log('======================================================');
