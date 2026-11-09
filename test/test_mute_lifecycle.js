/**
 * DuoAudio - Automated Verification Test for EndpointMuteManager
 *
 * Tests the complete lifecycle of endpoint muting:
 * 1. Querying default endpoint info and friendly name.
 * 2. Muting the endpoint and verifying mute state.
 * 3. Restoring the original unmuted state.
 * 4. Idempotent double-restoration (ensuring duplicate calls are safe no-ops).
 * 5. Disconnected endpoint ID handling (error handled gracefully without crash).
 * 6. Disabled mode (--no-mute).
 */

const { EndpointMuteManager } = require("../src/endpoint_mute");

async function runMuteLifecycleTest() {
  console.log("=================================================");
  console.log(" DuoAudio - Endpoint Mute Lifecycle Test         ");
  console.log("=================================================\n");

  const manager = new EndpointMuteManager();

  // Test 1: Query & Mute
  console.log("Test 1: Pre-flight query and mute...");
  const initResult = await manager.initAndMute();
  console.log("Init result:", initResult);

  if (!manager.targetEndpoint || !manager.targetEndpoint.id) {
    throw new Error("Failed to capture target endpoint ID.");
  }

  // Test 2: Double Mute attempt (already muted by DuoAudio)
  console.log("\nTest 2: Verifying endpoint is currently muted...");
  const verifyRes = await manager._runPsAsync(["get-by-id", manager.targetEndpoint.id]);
  console.log("Verify result:", verifyRes);
  if (!verifyRes.isMuted) {
    throw new Error("Endpoint was expected to be muted, but is unmuted!");
  }

  // Test 3: Normal Restoration
  console.log("\nTest 3: Restoring original state...");
  const restoreResult = await manager.restore();
  console.log("Restore result:", restoreResult);

  // Test 4: Verifying unmuted
  console.log("\nTest 4: Verifying endpoint is restored to unmuted...");
  const verifyRestore = await manager._runPsAsync(["get-by-id", manager.targetEndpoint.id]);
  console.log("Post-restore status:", verifyRestore);
  if (verifyRestore.isMuted) {
    throw new Error("Endpoint is still muted after restore!");
  }

  // Test 5: Idempotent duplicate restore call
  console.log("\nTest 5: Duplicate restore call (idempotency check)...");
  const dupRestore = await manager.restore();
  console.log("Duplicate restore result:", dupRestore);
  if (!dupRestore.skipped) {
    throw new Error("Duplicate restore should have been skipped!");
  }

  // Test 6: Disconnected device ID handling
  console.log("\nTest 6: Disconnected / non-existent endpoint ID handling...");
  const bogusManager = new EndpointMuteManager();
  bogusManager.targetEndpoint = { id: "{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}", name: "Disconnected Device" };
  bogusManager.isMutedByDuoAudio = true;
  bogusManager.originallyMuted = false;
  const bogusRestore = await bogusManager.restore();
  console.log("Disconnected device restore result:", bogusRestore);

  // Test 7: Disabled mode
  console.log("\nTest 7: Disabled manager (--no-mute)...");
  const disabledManager = new EndpointMuteManager({ enabled: false });
  const disabledInit = await disabledManager.initAndMute();
  console.log("Disabled init result:", disabledInit);
  const disabledRestore = await disabledManager.restore();
  console.log("Disabled restore result:", disabledRestore);

  console.log("\n=================================================");
  console.log(" All Endpoint Mute Lifecycle Tests PASSED!       ");
  console.log("=================================================");
}

runMuteLifecycleTest().catch((err) => {
  console.error("\n[TEST FAILED]:", err.message);
  process.exit(1);
});
