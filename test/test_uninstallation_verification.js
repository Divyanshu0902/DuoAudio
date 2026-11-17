/**
 * DuoAudio - Phase 5D.2D: Uninstallation Verification
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

console.log('======================================================');
console.log(' DuoAudio - Phase 5D.2D Uninstallation Verification   ');
console.log('======================================================\n');

const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
const installDir = path.join(localAppData, 'Programs', 'DuoAudio');
const uninstaller = path.join(installDir, 'Uninstall DuoAudio.exe');
const startMenuLnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DuoAudio.lnk');

// Query Desktop folder via PowerShell to handle redirected folders
const psDesktopQuery = `[Console]::WriteLine([Environment]::GetFolderPath('Desktop'))`;
const desktopFolder = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', psDesktopQuery], { encoding: 'utf8' }).trim();
const desktopLnk = path.join(desktopFolder, 'DuoAudio.lnk');

console.log('Step 1: Checking pre-uninstall state...');
assert.ok(fs.existsSync(installDir), 'Install dir must exist before uninstall');
assert.ok(fs.existsSync(uninstaller), 'Uninstaller must exist before uninstall');
console.log('  [+] Pre-uninstall state confirmed.');

console.log('\nStep 2: Executing silent uninstaller...');
console.log(`  Running: "${uninstaller}" /currentuser /S`);

// Spawn uninstaller without _?= so it copies to TEMP and removes installDir completely
cp.spawnSync(uninstaller, ['/currentuser', '/S'], {
  windowsHide: true
});

// Wait for uninstaller background worker to complete file and directory deletion
const start = Date.now();
while (Date.now() - start < 20000) {
  cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500']);
  if (!fs.existsSync(installDir)) break;
}
console.log('  [+] Uninstaller execution completed.');

console.log('\nStep 3: Verifying filesystem removal...');
// The installation directory should be completely removed
const dirExists = fs.existsSync(installDir);
console.log(`  Install Directory Removed: ${!dirExists} (${installDir})`);
assert.strictEqual(dirExists, false, 'Installation directory should be removed after uninstallation');

// Shortcuts should be removed
const startMenuExists = fs.existsSync(startMenuLnk);
console.log(`  Start Menu Shortcut Removed: ${!startMenuExists} (${startMenuLnk})`);
assert.strictEqual(startMenuExists, false, 'Start Menu shortcut should be removed');

const desktopExists = fs.existsSync(desktopLnk);
console.log(`  Desktop Shortcut Removed: ${!desktopExists} (${desktopLnk})`);
assert.strictEqual(desktopExists, false, 'Desktop shortcut should be removed');

console.log('\nStep 4: Verifying Registry uninstall entry removal...');
const regCheck = cp.spawnSync('reg.exe', [
  'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DuoAudio'
], { encoding: 'utf8' });
const regHasDuoAudio = regCheck.stdout && regCheck.stdout.includes('DuoAudio 1.0.0');
console.log(`  Registry Entry Removed: ${!regHasDuoAudio}`);
assert.strictEqual(regHasDuoAudio, false, 'Registry uninstall key must be removed');

console.log('\nStep 5: Verifying no lingering processes...');
const psCheckProc = `
$procs = Get-Process -Name '*DuoAudio*' -ErrorAction SilentlyContinue
[Console]::WriteLine($procs.Count)
`;
const procCount = parseInt(cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', psCheckProc], { encoding: 'utf8' }).trim(), 10);
console.log(`  Lingering DuoAudio processes: ${procCount}`);
assert.strictEqual(procCount, 0, 'No DuoAudio processes should remain running');

console.log('\nStep 6: Verifying default playback endpoint mute state...');
const { EndpointMuteManager } = require('../src/endpoint_mute');
const muteManager = new EndpointMuteManager();
(async () => {
  const ep = await muteManager.queryDefault();
  console.log(`  Default endpoint "${ep.name}" muted: ${ep.isMuted}`);
  assert.strictEqual(ep.isMuted, false, 'Default playback endpoint must not be left muted');

  console.log('\n======================================================');
  console.log(' All Uninstallation Checks PASSED!                   ');
  console.log('======================================================');
})();
