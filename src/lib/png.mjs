// Minimal pure-Node PNG codec (zlib built-in): decode -> crop rows -> encode.
// Supports 8-bit RGB/RGBA non-interlaced images (what Chrome and Figma emit).
// Used to slice tall page screenshots into reviewable strips for Claude vision.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * channels;
  const pixels = Buffer.alloc(ihdr.height * stride);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: return null;
      }
      out[x] = v;
    }
    prev = out;
  }
  return { width: ihdr.width, height: ihdr.height, channels, colorType: ihdr.colorType, pixels };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

export function encodePng({ width, height, channels, colorType, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export function cropPng(img, top, height) {
  const stride = img.width * img.channels;
  const h = Math.min(height, img.height - top);
  if (h <= 0) return null;
  return {
    width: img.width,
    height: h,
    channels: img.channels,
    colorType: img.colorType,
    pixels: img.pixels.subarray(top * stride, (top + h) * stride),
  };
}

// Slice a tall PNG buffer into N vertical strip buffers (with small overlap so
// content at strip seams stays readable). Returns [] if the PNG is unsupported.
export function slicePngVertical(buf, numStrips, overlap = 60) {
  const img = decodePng(buf);
  if (!img) return [];
  const stripH = Math.ceil(img.height / numStrips);
  const strips = [];
  for (let i = 0; i < numStrips; i++) {
    const top = Math.max(0, i * stripH - (i ? overlap : 0));
    const crop = cropPng(img, top, stripH + (i ? overlap : 0));
    if (crop) strips.push(encodePng(crop));
  }
  return strips;
}

export function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
