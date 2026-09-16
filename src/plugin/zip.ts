/** Minimal STORE-method ZIP writer (no compression, no dependencies). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { const lo = s.charCodeAt(i + 1); if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; } }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
interface Entry { name: string; size: number; crc: number; offset: number }
export class Zip {
  private parts: Uint8Array[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  add(name: string, content: string | Uint8Array): void {
    const data = typeof content === "string" ? utf8(content) : content;
    const nameB = utf8(name);
    const crc = crc32(data);
    const h = new Uint8Array(30 + nameB.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
    h.set(nameB, 30);
    this.entries.push({ name, size: data.length, crc, offset: this.offset });
    this.parts.push(h, data);
    this.offset += h.length + data.length;
  }
  finish(): Uint8Array {
    const central: Uint8Array[] = [];
    let cSize = 0;
    for (const e of this.entries) {
      const nameB = utf8(e.name);
      const c = new Uint8Array(46 + nameB.length);
      const dv = new DataView(c.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x0800, true); dv.setUint16(10, 0, true);
      dv.setUint32(16, e.crc, true); dv.setUint32(20, e.size, true); dv.setUint32(24, e.size, true);
      dv.setUint16(28, nameB.length, true); dv.setUint32(42, e.offset, true);
      c.set(nameB, 46); central.push(c); cSize += c.length;
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, this.entries.length, true); dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, cSize, true); dv.setUint32(16, this.offset, true);
    const out = new Uint8Array(this.offset + cSize + 22);
    let p = 0;
    for (const part of this.parts) { out.set(part, p); p += part.length; }
    for (const part of central) { out.set(part, p); p += part.length; }
    out.set(end, p);
    return out;
  }
}
