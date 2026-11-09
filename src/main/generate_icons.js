/**
 * DuoAudio - Icon Asset Generator
 * Generates assets/tray-icon.png and assets/app-icon.png using pure Node.js Buffer manipulation.
 * Creates a clean 32x32 RGBA PNG with an electric-blue dual-soundwave / headphone emblem.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height, pixelFn) {
  // Raw RGBA image data with scanline filter byte (0) per row
  const rawBytes = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;

  for (let y = 0; y < height; y++) {
    rawBytes[offset++] = 0; // Filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      rawBytes[offset++] = r;
      rawBytes[offset++] = g;
      rawBytes[offset++] = b;
      rawBytes[offset++] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawBytes);

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);

    // Calculate CRC32 over type + data
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0; // Deflate compression
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // No interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT
  const idatChunk = makeChunk('IDAT', compressedData);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Simple CRC32 implementation
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate DuoAudio 32x32 icon: two concentric electric-blue sound arcs with a central audio node
function drawDuoAudioIcon(x, y, w, h) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Electric blue: #3b82f6 (59, 130, 246)
  // Background: Transparent

  // Center core dot (dist <= 3.5)
  if (dist <= 3.5) {
    return [59, 130, 246, 255];
  }

  // Inner ring: dist between 6.5 and 9.0
  if (dist >= 6.0 && dist <= 8.5) {
    // Only left and right arcs (sound waves)
    const angle = Math.abs(Math.atan2(dy, dx));
    if (angle < 0.95 || angle > Math.PI - 0.95) {
      return [96, 165, 250, 255]; // Lighter electric blue
    }
  }

  // Outer ring: dist between 11.5 and 14.0
  if (dist >= 11.0 && dist <= 13.5) {
    const angle = Math.abs(Math.atan2(dy, dx));
    if (angle < 0.85 || angle > Math.PI - 0.85) {
      return [37, 99, 235, 240]; // Deep electric blue
    }
  }

  // Anti-aliased / transparent
  return [0, 0, 0, 0];
}

const assetsDir = path.join(__dirname, '../../assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const trayIconPng = createPng(32, 32, drawDuoAudioIcon);
fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'), trayIconPng);
fs.writeFileSync(path.join(assetsDir, 'app-icon.png'), trayIconPng);

console.log('[+] Generated assets/tray-icon.png and assets/app-icon.png successfully.');
