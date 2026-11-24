/**
 * Minimal PNG decoder (8-bit RGBA, non-interlaced: what the tile pipeline writes) that never touches a canvas.
 *
 * Why: browsers with fingerprinting protection (Brave) add random +-1 noise to canvas pixel reads. Our elevation
 * is stored as a high byte and a low byte, so a +-1 on the high byte is a 64 m error. Data must never be decoded
 * through a canvas or read back from WebGL.
 */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buffer: ArrayBuffer): Promise<DecodedImage> {
  const u8 = new Uint8Array(buffer);
  if (SIGNATURE.some((b, i) => u8[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(buffer);

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= u8.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const start = pos + 8;
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = u8[start + 8];
      colorType = u8[start + 9];
      interlace = u8[start + 12];
    } else if (type === 'IDAT') {
      idat.push(u8.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4; // data + CRC
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}): expected 8-bit RGBA`);
  }

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    compressed.set(c, o);
    o += c.length;
  }
  const raw = await inflate(compressed);

  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride; // previous output row (undefined for y = 0)
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let add: number;
      switch (filter) {
        case 0: add = 0; break;
        case 1: add = a; break;
        case 2: add = b; break;
        case 3: add = (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[dst + x] = (v + add) & 255;
    }
  }
  return { width, height, data: out };
}
