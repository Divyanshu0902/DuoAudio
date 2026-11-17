/**
 * DuoAudio - Phase 8.3: Reproducible Native Silence-Suppression Patch Utility
 *
 * Enforces reproducible modifications to loopback-capture@4.0.0:
 * 1. Updates C++ source code in node_modules/loopback-capture/src/platform/windows/LoopbackCapture.cpp
 *    to preserve silent audio packets by generating zero-filled PCM buffers instead of discarding them.
 * 2. Applies byte patch to prebuilds/win32-x64/loopback_capture_addon.node at raw file offset 0x6b82,
 *    replacing the silence-skip jump instruction (e9 49 01 00 00) with NOPs (90 90 90 90 90).
 *
 * Usage:
 *   node scripts/patch-loopback-capture.js           # Apply patch
 *   node scripts/patch-loopback-capture.js --revert  # Revert to original
 *   node scripts/patch-loopback-capture.js --status  # Check status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PKG_JSON_PATH = path.join(PROJECT_ROOT, 'node_modules', 'loopback-capture', 'package.json');
const CPP_SRC_PATH = path.join(PROJECT_ROOT, 'node_modules', 'loopback-capture', 'src', 'platform', 'windows', 'LoopbackCapture.cpp');
const CPP_BACKUP_PATH = CPP_SRC_PATH + '.orig';
const NODE_BIN_PATH = path.join(PROJECT_ROOT, 'node_modules', 'loopback-capture', 'prebuilds', 'win32-x64', 'loopback_capture_addon.node');
const NODE_BACKUP_PATH = NODE_BIN_PATH + '.orig';

// Binary patch configuration
const PATCH_RAW_OFFSET = 0x6b82;
const ORIGINAL_BYTES = Buffer.from('e949010000', 'hex'); // jmp 0x1800078d0 (skip emit)
const PATCHED_BYTES = Buffer.from('9090909090', 'hex');  // 5x NOP (fallthrough to emit)

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function checkEnvironment() {
  if (!fs.existsSync(PKG_JSON_PATH)) {
    console.error('[PATCH ERROR] loopback-capture is not installed in node_modules.');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON_PATH, 'utf8'));
  if (pkg.version !== '4.0.0') {
    console.warn(`[PATCH WARNING] Expected loopback-capture@4.0.0, found version ${pkg.version}.`);
  }
}

function getStatus() {
  checkEnvironment();
  console.log('--- loopback-capture Patch Status ---');

  if (fs.existsSync(CPP_SRC_PATH)) {
    const src = fs.readFileSync(CPP_SRC_PATH, 'utf8');
    const isSrcPatched = src.includes('zeroBuffer') && src.includes('AUDCLNT_BUFFERFLAGS_SILENT');
    console.log(`  Source (${path.basename(CPP_SRC_PATH)}): ${isSrcPatched ? 'PATCHED' : 'ORIGINAL'}`);
  } else {
    console.log(`  Source (${path.basename(CPP_SRC_PATH)}): NOT FOUND`);
  }

  if (fs.existsSync(NODE_BIN_PATH)) {
    const bin = fs.readFileSync(NODE_BIN_PATH);
    const slice = bin.subarray(PATCH_RAW_OFFSET, PATCH_RAW_OFFSET + 5);
    let binStatus = 'UNKNOWN';
    if (slice.equals(PATCHED_BYTES)) {
      binStatus = 'PATCHED (Silence suppression disabled; silent packets emitted)';
    } else if (slice.equals(ORIGINAL_BYTES)) {
      binStatus = 'ORIGINAL (Silence suppression active; silent packets dropped)';
    }
    console.log(`  Binary (${path.basename(NODE_BIN_PATH)}): ${binStatus}`);
    console.log(`  Binary SHA256: ${sha256(bin)}`);
  } else {
    console.log(`  Binary (${path.basename(NODE_BIN_PATH)}): NOT FOUND`);
  }
}

function applyPatch() {
  checkEnvironment();
  console.log('[PATCH] Applying silence-suppression patch to loopback-capture@4.0.0...');

  // 1. Patch C++ Source Code
  if (fs.existsSync(CPP_SRC_PATH)) {
    let src = fs.readFileSync(CPP_SRC_PATH, 'utf8');

    // Backup original if not backed up yet
    if (!fs.existsSync(CPP_BACKUP_PATH)) {
      fs.writeFileSync(CPP_BACKUP_PATH, src, 'utf8');
      console.log(`  [+] Created source backup: ${path.basename(CPP_BACKUP_PATH)}`);
    }

    if (!src.includes('<vector>')) {
      src = src.replace('#include <cstring>', '#include <cstring>\n#include <vector>');
    }

    const originalBlock = `      // Hand the buffer off to JS via the ThreadSafeFunction
      if (m_DeviceState != DeviceState::Stopping && !IsBufferSilent(Data, FramesAvailable, &m_CaptureFormat, -70))
      {
         size_t byteCount = FramesAvailable * m_CaptureFormat.nBlockAlign;
         EmitAudioData(Data, static_cast<UINT32>(byteCount));
      }`;

    const patchedBlock = `      // Hand the buffer off to JS via the ThreadSafeFunction
      if (m_DeviceState != DeviceState::Stopping)
      {
         size_t byteCount = FramesAvailable * m_CaptureFormat.nBlockAlign;
         bool isSilent = (dwCaptureFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
         if (!isSilent)
         {
            isSilent = IsBufferSilent(Data, FramesAvailable, &m_CaptureFormat, -70);
         }

         if (isSilent)
         {
            std::vector<BYTE> zeroBuffer(byteCount, 0);
            EmitAudioData(zeroBuffer.data(), static_cast<UINT32>(byteCount));
         }
         else
         {
            EmitAudioData(Data, static_cast<UINT32>(byteCount));
         }
      }`;

    if (src.includes(originalBlock)) {
      src = src.replace(originalBlock, patchedBlock);
      fs.writeFileSync(CPP_SRC_PATH, src, 'utf8');
      console.log('  [+] Successfully patched LoopbackCapture.cpp source.');
    } else if (src.includes('zeroBuffer')) {
      console.log('  [.] LoopbackCapture.cpp source is already patched.');
    } else {
      console.warn('  [!] Source code target block mismatch; skipping source edit.');
    }
  }

  // 2. Patch Native Binary (prebuilds/win32-x64/loopback_capture_addon.node)
  if (fs.existsSync(NODE_BIN_PATH)) {
    const bin = Buffer.from(fs.readFileSync(NODE_BIN_PATH));

    // Backup original binary if not backed up yet
    if (!fs.existsSync(NODE_BACKUP_PATH)) {
      fs.writeFileSync(NODE_BACKUP_PATH, bin);
      console.log(`  [+] Created binary backup: ${path.basename(NODE_BACKUP_PATH)}`);
    }

    const currentBytes = bin.subarray(PATCH_RAW_OFFSET, PATCH_RAW_OFFSET + 5);

    if (currentBytes.equals(PATCHED_BYTES)) {
      console.log('  [.] Native binary is already patched.');
    } else if (currentBytes.equals(ORIGINAL_BYTES)) {
      PATCHED_BYTES.copy(bin, PATCH_RAW_OFFSET);
      fs.writeFileSync(NODE_BIN_PATH, bin);
      console.log(`  [+] Successfully patched native binary at offset 0x${PATCH_RAW_OFFSET.toString(16)}.`);
      console.log(`      Patched binary SHA256: ${sha256(bin)}`);
    } else {
      console.error(`  [!] Unexpected bytes at offset 0x${PATCH_RAW_OFFSET.toString(16)}: ${currentBytes.toString('hex')}. Aborting binary patch.`);
      process.exit(1);
    }
  }

  console.log('[PATCH] Done. Silence suppression disabled.');
}

function revertPatch() {
  checkEnvironment();
  console.log('[PATCH] Reverting silence-suppression patch...');

  if (fs.existsSync(CPP_BACKUP_PATH)) {
    fs.copyFileSync(CPP_BACKUP_PATH, CPP_SRC_PATH);
    fs.unlinkSync(CPP_BACKUP_PATH);
    console.log('  [+] Restored original LoopbackCapture.cpp.');
  } else {
    console.log('  [.] No source backup found.');
  }

  if (fs.existsSync(NODE_BACKUP_PATH)) {
    fs.copyFileSync(NODE_BACKUP_PATH, NODE_BIN_PATH);
    fs.unlinkSync(NODE_BACKUP_PATH);
    console.log('  [+] Restored original loopback_capture_addon.node.');
  } else {
    console.log('  [.] No binary backup found.');
  }

  console.log('[PATCH] Done. Original behaviour restored.');
}

// CLI argument dispatch
const arg = process.argv[2];
if (arg === '--revert') {
  revertPatch();
} else if (arg === '--status') {
  getStatus();
} else {
  applyPatch();
}
