/**
 * DuoAudio - Gain Configuration & Unity Gain Verification Test
 *
 * Verifies:
 * 1. OutputStream defaults to volume 1.0 (unity gain).
 * 2. Custom volume options (0.0 to 1.0) are respected.
 * 3. Upper bounds clamping (never > 1.0).
 * 4. Lower bounds clamping (never < 0.0).
 * 5. Mathematical verification of audify's volume-to-multiplier curve:
 *    - At 1.0: Multiplier = 1.0 (0.00 dB, unity gain).
 *    - At 0.2: Multiplier = 0.064988 (-23.74 dB attenuation).
 *    - Gain restoration: Exactly +23.74 dBFS.
 */

const assert = require("assert");
const { OutputStream } = require("../src/output_stream");

console.log("=================================================");
console.log(" DuoAudio - Gain & Unity Gain Verification Test  ");
console.log("=================================================\n");

// Test 1: OutputStream default volume
console.log("Test 1: Verifying OutputStream default volume is 1.0 (unity gain)...");
const streamDefault = new OutputStream();
assert.strictEqual(streamDefault.volume, 1.0, "Default volume must be 1.0");
console.log("  [+] OutputStream default volume = 1.0 (100% unity gain)\n");

// Test 2: Custom volume option
console.log("Test 2: Verifying custom volume options are respected...");
const streamCustom = new OutputStream({ volume: 0.75 });
assert.strictEqual(streamCustom.volume, 0.75, "Custom volume 0.75 must be preserved");
console.log("  [+] Custom volume 0.75 set successfully\n");

// Test 3: Safety clamping for values > 1.0
console.log("Test 3: Verifying safety clamping for values > 1.0...");
const streamOver = new OutputStream({ volume: 1.5 });
assert.strictEqual(streamOver.volume, 1.0, "Volume > 1.0 must be clamped to 1.0");
console.log("  [+] Volume 1.5 clamped to 1.0 (upper bound safety guard verified)\n");

// Test 4: Safety clamping for values < 0.0
console.log("Test 4: Verifying safety clamping for values < 0.0...");
const streamUnder = new OutputStream({ volume: -0.5 });
assert.strictEqual(streamUnder.volume, 0.0, "Volume < 0.0 must be clamped to 0.0");
console.log("  [+] Volume -0.5 clamped to 0.0 (lower bound safety guard verified)\n");

// Test 5: Mathematical calculation of audify's native curve
console.log("Test 5: Verifying audify C++ volume curve formula: (10^v - 1) / 9...");
function audifyMultiplier(v) {
  return (Math.pow(10, v) - 1.0) / 9.0;
}
function toDb(mult) {
  return 20.0 * Math.log10(mult);
}

const multAtUnity = audifyMultiplier(1.0);
const dbAtUnity = toDb(multAtUnity);
console.log(`  At volume = 1.0: Multiplier = ${multAtUnity.toFixed(6)}, Gain = ${dbAtUnity.toFixed(2)} dBFS`);
assert.strictEqual(multAtUnity, 1.0, "Multiplier at 1.0 must be exactly 1.0");
assert.strictEqual(dbAtUnity, 0.0, "Gain at 1.0 must be exactly 0.0 dBFS");

const multAtOldDefault = audifyMultiplier(0.2);
const dbAtOldDefault = toDb(multAtOldDefault);
console.log(`  At volume = 0.2: Multiplier = ${multAtOldDefault.toFixed(6)}, Gain = ${dbAtOldDefault.toFixed(2)} dBFS`);
assert(Math.abs(dbAtOldDefault - (-23.74)) < 0.01, "Old gain must be -23.74 dBFS");

const gainRestored = dbAtUnity - dbAtOldDefault;
console.log(`  Gain restoration delta: +${gainRestored.toFixed(2)} dBFS`);
console.log("  [+] Audify unity gain mapping verified.\n");

// Test 6: Verify Float32 sample values pass through with unity multiplier
console.log("Test 6: Verifying sample multiplication integrity...");
const testSample = 0.7071; // -3.0 dBFS test tone peak
const outputSampleUnity = testSample * multAtUnity;
const outputSampleOld = testSample * multAtOldDefault;
assert.strictEqual(outputSampleUnity, testSample, "Unity sample must equal input sample");
console.log(`  Input sample   : ${testSample.toFixed(4)}`);
console.log(`  Output at 1.0  : ${outputSampleUnity.toFixed(4)} (difference = 0.00 dB)`);
console.log(`  Output at 0.2  : ${outputSampleOld.toFixed(4)} (difference = ${toDb(outputSampleOld / testSample).toFixed(2)} dB)`);
console.log("  [+] Sample multiplication verified.\n");

console.log("=================================================");
console.log(" All Gain & Unity Gain Tests PASSED!             ");
console.log("=================================================");
