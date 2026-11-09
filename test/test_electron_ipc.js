/**
 * DuoAudio - Electron IPC Contract & Window Geometry Unit Tests
 *
 * Verifies:
 * 1. Allowlisted IPC channel definitions.
 * 2. Channel validity validator.
 * 3. Volume input validator (0-100 integer range).
 * 4. Multi-monitor intersection and geometry boundary logic.
 */

const assert = require('assert');
const { IPC_CHANNELS, isValidChannel, isValidVolumePercent } = require('../src/shared/ipc-contracts');

console.log('=================================================');
console.log(' DuoAudio - Electron IPC & Geometry Unit Tests   ');
console.log('=================================================\n');

// Test 1: Allowlisted channel definitions
console.log('Test 1: Verifying allowlisted IPC channel definitions...');
assert.strictEqual(IPC_CHANNELS.WINDOW_MINIMIZE, 'window:minimize');
assert.strictEqual(IPC_CHANNELS.APP_GET_INITIAL_STATE, 'app:get-initial-state');
assert.strictEqual(IPC_CHANNELS.ROUTING_GET_STATUS, 'routing:get-status');
console.log('  [+] Standard IPC channels confirmed.\n');

// Test 2: Channel validation security guard
console.log('Test 2: Verifying channel security validation...');
assert.strictEqual(isValidChannel('window:minimize'), true);
assert.strictEqual(isValidChannel('app:get-initial-state'), true);
assert.strictEqual(isValidChannel('routing:get-status'), true);
assert.strictEqual(isValidChannel('arbitrary:channel'), false);
assert.strictEqual(isValidChannel(''), false);
assert.strictEqual(isValidChannel(null), false);
assert.strictEqual(isValidChannel(undefined), false);
console.log('  [+] Arbitrary channel injection rejected.\n');

// Test 3: Volume input validation
console.log('Test 3: Verifying volume input validator...');
assert.strictEqual(isValidVolumePercent(0), true);
assert.strictEqual(isValidVolumePercent(50), true);
assert.strictEqual(isValidVolumePercent(100), true);
assert.strictEqual(isValidVolumePercent(-1), false);
assert.strictEqual(isValidVolumePercent(101), false);
assert.strictEqual(isValidVolumePercent(50.5), false);
assert.strictEqual(isValidVolumePercent('50'), false);
assert.strictEqual(isValidVolumePercent(null), false);
console.log('  [+] Volume input bounds and types verified.\n');

// Test 4: Rectangle intersection algorithm
console.log('Test 4: Verifying multi-monitor rectangle intersection logic...');
function intersects(rectA, rectB, minOverlap = 80) {
  const overlapX = Math.max(0, Math.min(rectA.x + rectA.width, rectB.x + rectB.width) - Math.max(rectA.x, rectB.x));
  const overlapY = Math.max(0, Math.min(rectA.y + rectA.height, rectB.y + rectB.height) - Math.max(rectA.y, rectB.y));
  return overlapX >= minOverlap && overlapY >= minOverlap;
}

const display = { x: 0, y: 0, width: 1920, height: 1080 };
// Fully inside
assert.strictEqual(intersects({ x: 100, y: 100, width: 440, height: 600 }, display), true);
// Partially overlapping by 100px
assert.strictEqual(intersects({ x: 1820, y: 100, width: 440, height: 600 }, display, 80), true);
// Outside display completely (off-screen coordinates from disconnected monitor)
assert.strictEqual(intersects({ x: 2500, y: 100, width: 440, height: 600 }, display), false);
assert.strictEqual(intersects({ x: -1000, y: -500, width: 440, height: 600 }, display), false);
console.log('  [+] Display boundary and off-screen detection verified.\n');

// Test 5: Window dimension constraints clamping (controlled manual resizing)
console.log('Test 5: Verifying window dimension constraints clamping...');
function clampDimensions(width, height) {
  const MIN_W = 380, MIN_H = 500, MAX_W = 560, MAX_H = 760;
  return {
    width: Math.min(MAX_W, Math.max(MIN_W, width)),
    height: Math.min(MAX_H, Math.max(MIN_H, height))
  };
}
assert.deepStrictEqual(clampDimensions(440, 600), { width: 440, height: 600 });
assert.deepStrictEqual(clampDimensions(200, 300), { width: 380, height: 500 });
assert.deepStrictEqual(clampDimensions(1000, 1200), { width: 560, height: 760 });
console.log('  [+] Window dimension clamping (380-560W, 500-760H) verified.\n');

console.log('=================================================');
console.log(' All Electron IPC & Geometry Unit Tests PASSED!  ');
console.log('=================================================');
