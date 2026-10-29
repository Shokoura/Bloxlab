// LZ4 block format (no frame), as used by Roblox binary files and meshes.

export function lz4Decompress(src, outLen) {
  const dst = new Uint8Array(outLen);
  let s = 0, d = 0;
  const end = src.length;
  while (s < end) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(s, s + lit), d);
    s += lit; d += lit;
    if (s >= end) break;
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0) throw new Error('lz4: zero offset');
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    let m = d - offset;
    if (m < 0) throw new Error('lz4: bad offset');
    if (offset >= len) { dst.copyWithin(d, m, m + len); d += len; }
    else { for (let i = 0; i < len; i++) dst[d++] = dst[m++]; }
  }
  if (d !== outLen) throw new Error(`lz4: expected ${outLen} bytes, got ${d}`);
  return dst;
}

// Simple greedy compressor (hash of 4 bytes, 64 KB window). Produces valid LZ4 blocks.
export function lz4Compress(src) {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  const table = new Int32Array(1 << 14).fill(-1);
  let o = 0, anchor = 0, i = 0;
  const limit = n - 12;
  const hash = (p) => (Math.imul(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24), 2654435761) >>> 18);
  const writeLen = (len) => { while (len >= 255) { out[o++] = 255; len -= 255; } out[o++] = len; };
  while (i < limit) {
    const h = hash(i);
    const ref = table[h];
    table[h] = i;
    if (ref >= 0 && i - ref < 65536 && src[ref] === src[i] && src[ref + 1] === src[i + 1] && src[ref + 2] === src[i + 2] && src[ref + 3] === src[i + 3]) {
      let len = 4;
      while (i + len < n - 5 && src[ref + len] === src[i + len]) len++;
      const lit = i - anchor;
      const tok = o++;
      out[tok] = (Math.min(lit, 15) << 4) | Math.min(len - 4, 15);
      if (lit >= 15) writeLen(lit - 15);
      out.set(src.subarray(anchor, i), o); o += lit;
      const off = i - ref;
      out[o++] = off & 255; out[o++] = off >>> 8;
      if (len - 4 >= 15) writeLen(len - 4 - 15);
      i += len; anchor = i;
    } else i++;
  }
  const lit = n - anchor;
  out[o++] = Math.min(lit, 15) << 4;
  if (lit >= 15) writeLen(lit - 15);
  out.set(src.subarray(anchor), o); o += lit;
  return out.subarray(0, o);
}
