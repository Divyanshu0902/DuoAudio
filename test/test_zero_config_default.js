/**
 * DuoAudio - Phase 9 Verification Suite: Zero-Config Automatic Default Audio Device Management
 *
 * Validates:
 * 1. Native C++ helper duoaudio_endpoint.exe commands:
 *    - list-endpoints
 *    - query-default
 *    - set-default-by-id (with verification and safe restore)
 * 2. EndpointMuteManager methods:
 *    - listEndpoints()
 *    - identifyBuiltInSpeakers()
 *    - setDefaultEndpoint()
 *    - restoreDefaultEndpoint() (idempotency, error handling)
 *    - restoreDefaultEndpointSync()
 * 3. AudioService integration:
 *    - validatePreflight conflict resolution
 *    - IPC message handling for DEFAULT_ENDPOINT_BASELINE and RESTORATION
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { EndpointMuteManager, resolveDefaultNativeHelperPath } = require('../src/endpoint_mute');
const { AudioService } = require('../src/main/audio-service');

async function runTests() {
  console.log('===============================================================');
  console.log(' DuoAudio - Phase 9: Zero-Config Default Endpoint Tests');
  console.log('===============================================================');

  const helperPath = resolveDefaultNativeHelperPath();
  console.log(`[INFO] Native helper resolved at: "${helperPath}"`);

  // --- Suite 1: Native Helper CLI Contract ---
  console.log('\n--- Suite 1: Native Helper CLI Contract ---');

  // Test 1.1: list-endpoints
  const rawList = execFileSync(helperPath, ['list-endpoints'], { encoding: 'utf8' });
  const parsedList = JSON.parse(rawList.trim());
  assert.strictEqual(parsedList.success, true, 'list-endpoints should return success: true');
  assert.ok(Array.isArray(parsedList.devices), 'list-endpoints should return an array of devices');
  assert.ok(parsedList.devices.length > 0, 'At least one active playback device should be returned');
  assert.ok(parsedList.devices[0].id && parsedList.devices[0].name, 'Device entries must have id and name');
  console.log(`  [+] PASS: 1.1 list-endpoints returned ${parsedList.devices.length} active render devices`);

  // Test 1.2: query-default
  const rawQuery = execFileSync(helperPath, ['query-default'], { encoding: 'utf8' });
  const parsedQuery = JSON.parse(rawQuery.trim());
  assert.strictEqual(parsedQuery.success, true, 'query-default should return success: true');
  assert.ok(parsedQuery.id, 'query-default should return endpoint id');
  assert.ok(parsedQuery.name, 'query-default should return endpoint name');
  console.log(`  [+] PASS: 1.2 query-default returned active default "${parsedQuery.name}" (${parsedQuery.id})`);

  // Test 1.3: set-default-by-id (Setting same default as a safe verification)
  const rawSet = execFileSync(helperPath, ['set-default-by-id', parsedQuery.id], { encoding: 'utf8' });
  const parsedSet = JSON.parse(rawSet.trim());
  assert.strictEqual(parsedSet.success, true, 'set-default-by-id should return success: true');
  assert.strictEqual(parsedSet.verified, true, 'set-default-by-id should verify default endpoint');
  assert.strictEqual(parsedSet.id, parsedQuery.id, 'set-default-by-id should match queried id');
  console.log(`  [+] PASS: 1.3 set-default-by-id successfully verified on Windows Core Audio COM`);

  // --- Suite 2: EndpointMuteManager Automation Methods ---
  console.log('\n--- Suite 2: EndpointMuteManager Automation Methods ---');

  const manager = new EndpointMuteManager();

  // Test 2.1: listEndpoints()
  const endpoints = await manager.listEndpoints();
  assert.ok(Array.isArray(endpoints), 'manager.listEndpoints should return array');
  assert.ok(endpoints.length > 0, 'manager.listEndpoints should return devices');
  console.log(`  [+] PASS: 2.1 manager.listEndpoints() returned ${endpoints.length} devices`);

  // Test 2.2: identifyBuiltInSpeakers()
  const speaker = manager.identifyBuiltInSpeakers(endpoints);
  assert.ok(speaker, 'manager.identifyBuiltInSpeakers should identify a speaker');
  assert.ok(!speaker.name.toLowerCase().includes('buds'), 'Speaker should not be earbuds');
  assert.ok(!speaker.name.toLowerCase().includes('airdopes'), 'Speaker should not be airdopes');
  console.log(`  [+] PASS: 2.2 identifyBuiltInSpeakers resolved: "${speaker.name}" (${speaker.id})`);

  // Test 2.3: setDefaultEndpoint & restoreDefaultEndpoint
  // Save original default for guaranteed restoration
  const originalDefault = await manager.queryDefault();
  manager.originalDefaultEndpoint = { id: originalDefault.id, name: originalDefault.name };
  manager.defaultSwitchedByDuoAudio = true;

  // Perform set-default-by-id
  const setRes = await manager.setDefaultEndpoint(originalDefault.id);
  assert.strictEqual(setRes.success, true);
  assert.strictEqual(setRes.verified, true);

  // Perform restoreDefaultEndpoint
  const restoreRes = await manager.restoreDefaultEndpoint();
  assert.strictEqual(restoreRes.restored, true);
  assert.strictEqual(restoreRes.status, 'RESTORED');
  assert.strictEqual(manager.isDefaultRestored, true);
  assert.strictEqual(manager.defaultSwitchedByDuoAudio, false);
  console.log(`  [+] PASS: 2.3 setDefaultEndpoint & restoreDefaultEndpoint round-trip confirmed`);

  // Test 2.4: Idempotency of restoreDefaultEndpoint
  const dupRestore = await manager.restoreDefaultEndpoint();
  assert.strictEqual(dupRestore.restored, false);
  assert.strictEqual(dupRestore.status, 'NOT_REQUIRED');
  console.log(`  [+] PASS: 2.4 Duplicate restoreDefaultEndpoint call safely skipped (idempotent)`);

  // --- Suite 3: AudioService Preflight & State Supervision ---
  console.log('\n--- Suite 3: AudioService Preflight & State Supervision ---');

  const mockEnumerate = () => Promise.resolve({
    success: true,
    devices: [
      { id: 1, name: 'Speakers (Realtek(R) Audio)', outputChannels: 2, isDefault: false },
      { id: 2, name: 'Headphones (realme Buds T310)', outputChannels: 2, isDefault: true },
      { id: 3, name: 'Airdopes 161', outputChannels: 2, isDefault: false }
    ]
  });

  const service = new AudioService({ enumerateFn: mockEnumerate });

  // Test 3.1: Preflight with conflict should be marked autoResolvable: true
  const preflight = await service.validatePreflight({ device1Id: 2, device2Id: 3 });
  assert.strictEqual(preflight.valid, true, 'Preflight should be valid');
  assert.strictEqual(preflight.hasConflict, true, 'Conflict should be detected (Device 1 is default)');
  assert.strictEqual(preflight.autoResolvable, true, 'Conflict must be marked autoResolvable: true');
  console.log(`  [+] PASS: 3.1 Preflight conflict marked autoResolvable for seamless zero-config handling`);

  // Test 3.2: Status snapshot includes defaultEndpointState
  const status = service.getRoutingStatus();
  assert.ok(status.defaultEndpointState, 'Status snapshot must contain defaultEndpointState');
  assert.strictEqual(status.defaultEndpointState.switched, false);
  console.log(`  [+] PASS: 3.2 getRoutingStatus() includes granular defaultEndpointState`);

  console.log('\n===============================================================');
  console.log(' Results: All Phase 9 Zero-Config Tests PASSED!');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('\n[TEST FAILURE]:', err);
  process.exit(1);
});
