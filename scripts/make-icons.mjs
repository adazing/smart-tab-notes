/**
 * Generates the toolbar icons into public/icons.
 *
 * Checked-in PNGs would be fine too, but generating them keeps the repo
 * free of binaries nobody can diff, and makes the placeholder easy to
 * replace: change the drawing below and run `npm run icons`.
 *
 * The mark is a blue rounded square with three note lines, one of them
 * highlighted -- a line of text with an answer pinned to it.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

const BLUE = [47, 109, 246, 255];
const WHITE = [255, 255, 255, 255];
const FADED = [255, 255, 255, 150];
const CLEAR = [0, 0, 0, 0];

/** Draw one icon as a size x size array of RGBA pixels. */
function draw(size) {
  const px = (n) => Math.round((n / 16) * size);
  const radius = px(3.5);
  const pixels = new Uint8Array(size * size * 4);

  const lines = [
    { top: px(4), left: px(3.5), right: px(12.5), color: FADED },
    { top: px(7.5), left: px(3.5), right: px(10), color: WHITE },
    { top: px(11), left: px(3.5), right: px(12.5), color: FADED },
  ];
  const lineHeight = Math.max(1, px(1.5));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let color = CLEAR;

      // Rounded square body.
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inCorner = dx < radius && dy < radius;
      const cornerDist = Math.hypot(radius - dx, radius - dy);
      if (!inCorner || cornerDist <= radius) color = BLUE;

      // Note lines on top of it.
      if (color === BLUE) {
        for (const line of lines) {
          if (y >= line.top && y < line.top + lineHeight && x >= line.left && x < line.right) {
            color = line.color;
            break;
          }
        }
      }

      const offset = (y * size + x) * 4;
      pixels.set(color, offset);
    }
  }

  return pixels;
}

/** Wrap raw RGBA pixels in a minimal PNG container. */
function toPng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, toPng(size, draw(size)));
  console.log('wrote', file);
}
