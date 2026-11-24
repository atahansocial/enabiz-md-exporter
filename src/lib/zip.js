/**
 * Zero-dependency PKZIP archive builder supporting UTF-8 filenames (flag 0x0800),
 * IEEE 802.3 CRC-32, and Deflate compression via Web CompressionStream('deflate-raw')
 * with graceful STORE fallback.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const yr = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((yr - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined' || bytes.length < 64) {
    return { method: 0, data: bytes };
  }
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const outBuf = await new Response(cs.readable).arrayBuffer();
    await writePromise;
    const compressed = new Uint8Array(outBuf);
    if (compressed.length < bytes.length) {
      return { method: 8, data: compressed };
    }
  } catch {
    // Fallback to STORE if deflate-raw is unsupported
  }
  return { method: 0, data: bytes };
}

/**
 * Create a PKZIP Uint8Array from an array or Map of entries.
 * @param {Array<{path: string, content: string | Uint8Array}> | Map<string, string | Uint8Array>} entriesInput
 * @param {object} [opts] - { rootFolder?: string, date?: Date }
 * @returns {Promise<Uint8Array>}
 */
export async function createZipBytes(entriesInput, opts = {}) {
  const rootFolder = opts.rootFolder === undefined ? 'enabiz-md-arsiv' : opts.rootFolder;
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosTimeDate(opts.date || new Date());

  const entries = entriesInput instanceof Map
    ? Array.from(entriesInput.entries()).map(([path, content]) => ({ path, content }))
    : Array.from(entriesInput || []);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanRel = String(entry.path).replace(/^\/+/, '');
    const fullName = rootFolder ? `${rootFolder}/${cleanRel}` : cleanRel;
    const nameBytes = encoder.encode(fullName);
    const rawBytes = typeof entry.content === 'string' ? encoder.encode(entry.content) : new Uint8Array(entry.content);
    const crc = crc32(rawBytes);
    const { method, data: compBytes } = await deflateRaw(rawBytes);

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, method, true); // compression method
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compBytes.length, true);
    lv.setUint32(22, rawBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, compBytes);

    // Central directory header (46 bytes + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compBytes.length, true);
    cv.setUint32(24, rawBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); // local header offset
    ch.set(nameBytes, 46);

    centralParts.push(ch);
    offset += lh.length + compBytes.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLength = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

export async function createZipBlob(entriesInput, opts = {}) {
  const bytes = await createZipBytes(entriesInput, opts);
  return new Blob([bytes], { type: 'application/zip' });
}
