'use strict';

/**
 * Pure-JS CRC used by prism-media's OggLogicalBitstream:
 *   crc(32, false, 0x04c11db7, 0, 0, 0, 0, 0, buffer) -> Buffer(4 BE)
 *
 * Matches the libogg CRC-32 (poly 0x04c11db7, init 0, no reflection).
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      r >>>= 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc32(buffer) {
  let crc = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ buffer[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Generic entry point used by prism-media.
 * Falls back to Ogg CRC-32 for the parameters prism always passes.
 */
function crc(bitLength, reflect, poly, _a, _b, _c, _d, _e, data) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    return false;
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  // prism-media always uses: 32, false, 0x04c11db7, zeros..., buffer
  if (bitLength === 32 && poly === 0x04c11db7) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(oggCrc32(buf), 0);
    return out;
  }
  // Minimal general path for 32-bit unreflected CRC with given poly
  if (bitLength === 32) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let r = i << 24;
      for (let j = 0; j < 8; j += 1) {
        r = r & 0x80000000 ? (r << 1) ^ (poly >>> 0) : r << 1;
        r >>>= 0;
      }
      table[i] = r >>> 0;
    }
    let value = 0;
    for (let i = 0; i < buf.length; i += 1) {
      value = ((value << 8) ^ table[((value >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value, 0);
    return out;
  }
  return false;
}

module.exports = { crc, oggCrc32 };
