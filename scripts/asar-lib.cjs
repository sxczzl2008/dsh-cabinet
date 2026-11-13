'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const hash = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

function open(file) {
  const bytes = fs.readFileSync(file);
  const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)));
  const base = 8 + bytes.readUInt32LE(4);
  const entry = p => p.split('/').reduce((n, k) => n?.files?.[k], header);
  return {
    file,
    bytes,
    header,
    base,
    entry,
    read(p) {
      const e = entry(p);
      if (!e || e.link || e.unpacked || e.files) throw new Error('Not packed regular file: ' + p);
      return bytes.subarray(base + Number(e.offset), base + Number(e.offset) + e.size);
    }
  };
}

function pack(archive, replacements) {
  const header = JSON.parse(JSON.stringify(archive.header));
  for (const [p] of replacements) {
    const parts = p.split('/');
    let n = header;
    for (const k of parts.slice(0, -1)) {
      n.files ??= {};
      n.files[k] ??= { files: {} };
      n = n.files[k];
    }
    const k = parts.at(-1);
    if (n.files?.[k]?.unpacked || n.files?.[k]?.link) throw new Error('Cannot replace unpacked/link entry');
    n.files ??= {};
    n.files[k] ??= { size: 0, offset: '0' };
  }
  let offset = 0;
  const chunks = [];
  function walk(n, p = '') {
    for (const [k, e] of Object.entries(n.files ?? {})) {
      const f = p + k;
      if (e.files) walk(e, f + '/');
      else if (!e.unpacked && !e.link) {
        const b = replacements.get(f) ?? archive.read(f);
        if (replacements.has(f)) {
          e.integrity = {
            algorithm: 'SHA256',
            hash: hash(b).toLowerCase(),
            blockSize: 4194304,
            blocks: Array.from(
              { length: Math.ceil(b.length / 4194304) },
              (_, i) => hash(b.subarray(i * 4194304, (i + 1) * 4194304)).toLowerCase()
            )
          };
        }
        e.offset = String(offset);
        e.size = b.length;
        offset += b.length;
        chunks.push(b);
      }
    }
  }
  walk(header);
  const hb = Buffer.from(JSON.stringify(header));
  const aligned = Math.ceil((4 + hb.length) / 4) * 4;
  const prefix = Buffer.alloc(12 + aligned);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + aligned, 4);
  prefix.writeUInt32LE(aligned, 8);
  prefix.writeUInt32LE(hb.length, 12);
  hb.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}

module.exports = { open, pack, hash };
