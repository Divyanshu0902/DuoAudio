/**
 * DuoAudio - Windows Application Icon Generator (.ico)
 *
 * Generates assets/icon.ico using pure Node.js Buffer manipulation.
 * Creates standard multi-resolution icon frames: 16, 24, 32, 48, 64, 128, 256 px.
 * Accurately reproduces the approved 4-bar equalizer soundwave visual identity.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function createPng(width, height, pixelFn) {
  const rawBytes = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawBytes[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      rawBytes[offset++] = r;
      rawBytes[offset++] = g;
      rawBytes[offset++] = b;
      rawBytes[offset++] = a;
    }
  }
  const compressed = zlib.deflateSync(rawBytes);
  function chunk(type, data) {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(buf.subarray(4, 8 + data.length)), 8 + data.length);
    return buf;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

function sdRoundedRect(px, py, rx, ry, rw, rh, rad) {
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const dx = Math.abs(px - cx) - (rw / 2 - rad);
  const dy = Math.abs(py - cy) - (rh / 2 - rad);
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  const distOutside = Math.sqrt(qx * qx + qy * qy);
  const distInside = Math.min(Math.max(dx, dy), 0);
  return distOutside + distInside - rad;
}

function renderDuoAudioFrame(size) {
  const margin = size * 0.12;
  const contentW = size - 2 * margin;
  const contentH = contentW * (24 / 25);
  const originX = margin;
  const originY = (size - contentH) / 2;
  const scale = contentW / 25;

  const bars = [
    { x: 0, y: 7, w: 4, h: 10, r: 2, col: [99, 113, 211] },
    { x: 7, y: 0, w: 4, h: 24, r: 2, col: [101, 115, 214] },
    { x: 14, y: 4, w: 4, h: 16, r: 2, col: [120, 133, 217] },
    { x: 21, y: 9, w: 4, h: 6, r: 2, col: [140, 149, 198] }
  ];

  return createPng(size, size, (px, py) => {
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    const subOffsets = [0.25, 0.75];
    for (const sx of subOffsets) {
      for (const sy of subOffsets) {
        const subX = px + sx;
        const subY = py + sy;
        for (const b of bars) {
          const bx = originX + b.x * scale;
          const by = originY + b.y * scale;
          const bw = b.w * scale;
          const bh = b.h * scale;
          const brad = Math.max(1, b.r * scale);
          const dist = sdRoundedRect(subX, subY, bx, by, bw, bh, brad);
          if (dist <= 0) {
            sumR += b.col[0];
            sumG += b.col[1];
            sumB += b.col[2];
            sumA += 255;
            break;
          }
        }
      }
    }
    return [Math.round(sumR / 4), Math.round(sumG / 4), Math.round(sumB / 4), Math.round(sumA / 4)];
  });
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = sizes.map((s) => renderDuoAudioFrame(s));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);

let offset = 6 + 16 * sizes.length;
const entries = [];
for (let i = 0; i < sizes.length; i++) {
  const s = sizes[i];
  const png = pngBuffers[i];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(s === 256 ? 0 : s, 0);
  entry.writeUInt8(s === 256 ? 0 : s, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += png.length;
}

const icoBuffer = Buffer.concat([header, ...entries, ...pngBuffers]);
const assetsDir = path.resolve(__dirname, '../../assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);
console.log('[+] Generated assets/icon.ico successfully (' + icoBuffer.length + ' bytes, 7 resolutions).');
