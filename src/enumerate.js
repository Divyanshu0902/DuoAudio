/**
 * DuoAudio - Phase 1: Audio Device Enumeration
 *
 * Enumerates active Windows audio playback endpoints using the WASAPI backend.
 * Identifies runtime device IDs, channel counts, sample rates, and flags
 * known target endpoints dynamically.
 */

const { RtAudio, RtAudioApi } = require("audify");

// Target devices to dynamically identify (case-insensitive substring match)
const TARGET_DEVICES = [
  { key: "realme", label: "realme Buds T310" },
  { key: "airdopes", label: "Airdopes 161" }
];

function formatSampleRates(rates, preferred) {
  if (!Array.isArray(rates) || rates.length === 0) {
    return preferred ? `${preferred} Hz (preferred; list not exposed)` : "Not exposed by driver";
  }
  const formatted = rates.map((r) => (r === preferred ? `${r}*` : `${r}`)).join(", ");
  return `${formatted} Hz (* = preferred: ${preferred || "unknown"} Hz)`;
}

function runEnumeration() {
  console.log("=================================================");
  console.log(" DuoAudio - Windows Audio Playback Enumeration   ");
  console.log(" Backend: Windows Audio Session API (WASAPI)    ");
  console.log("=================================================\n");

  let rtAudio;
  try {
    rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  } catch (err) {
    console.error("[FATAL ERROR] Failed to initialize RtAudio with WASAPI backend:", err.message);
    process.exit(1);
  }

  const apiName = typeof rtAudio.getApi === "function" ? rtAudio.getApi() : "WASAPI";
  console.log(`Initialized Audio Backend: ${apiName}\n`);

  let allDevices = [];
  try {
    allDevices = rtAudio.getDevices();
  } catch (err) {
    console.error("[FATAL ERROR] Failed to query devices from audio backend:", err.message);
    process.exit(1);
  }

  if (!Array.isArray(allDevices) || allDevices.length === 0) {
    console.warn("[WARNING] No audio devices reported by the backend.");
    process.exit(0);
  }

  // Filter for playback endpoints (outputChannels > 0)
  const playbackDevices = allDevices.filter((dev) => dev && dev.outputChannels > 0);

  console.log(`Found ${playbackDevices.length} active playback endpoint(s) (out of ${allDevices.length} total endpoints):\n`);

  const matchedTargets = new Set();

  playbackDevices.forEach((dev, index) => {
    const isDefault = dev.isDefaultOutput ? " [DEFAULT OUTPUT]" : "";
    console.log(`-------------------------------------------------`);
    console.log(`[#${index + 1}] ${dev.name || "Unknown Device"}${isDefault}`);
    console.log(`  Runtime Device ID   : ${dev.id !== undefined ? dev.id : "Unavailable"}`);
    console.log(`  Output Channels     : ${dev.outputChannels !== undefined ? dev.outputChannels : "Unavailable"}`);
    console.log(`  Input Channels      : ${dev.inputChannels !== undefined ? dev.inputChannels : 0}`);
    console.log(`  Preferred Rate      : ${dev.preferredSampleRate ? `${dev.preferredSampleRate} Hz` : "Not exposed"}`);
    console.log(`  Supported Rates     : ${formatSampleRates(dev.sampleRates, dev.preferredSampleRate)}`);
    console.log(`  Native Formats Mask : ${dev.nativeFormats !== undefined ? `0x${dev.nativeFormats.toString(16)}` : "Not exposed"}`);

    // Check target matching
    const devNameLower = (dev.name || "").toLowerCase();
    for (const target of TARGET_DEVICES) {
      if (devNameLower.includes(target.key)) {
        console.log(`  >>> TARGET MATCHED: ${target.label} <<<`);
        matchedTargets.add(target.label);
      }
    }
  });

  console.log(`-------------------------------------------------\n`);

  // Summary of target device detection
  console.log("Target Earbuds Status:");
  TARGET_DEVICES.forEach((target) => {
    if (matchedTargets.has(target.label)) {
      console.log(`  [OK] ${target.label}: Detected as active playback endpoint.`);
    } else {
      console.log(`  [--] ${target.label}: Not detected among active playback endpoints.`);
      console.log(`       (Note: Ensure earbuds are removed from case, powered on, and connected via Bluetooth.)`);
    }
  });

  console.log("\nEnumeration completed successfully.");
}

runEnumeration();
