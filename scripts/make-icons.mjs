import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "web", "icons");
fs.mkdirSync(outDir, { recursive: true });

const BG = [0x0e, 0x12, 0x16, 255];
const FG = [0x4d, 0xa3, 0xff, 255];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba.set(BG, i * 4);
  }
  const s = size / 512;
  const rects = [
    [88, 140, 424, 192],
    [148, 140, 204, 384],
    [308, 140, 364, 384],
    [364, 336, 396, 384],
  ];
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++) {
      for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) {
        rgba.set(FG, (y * size + x) * 4);
      }
    }
  }
  return encodePng(size, rgba);
}

for (const size of [180, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), drawIcon(size));
}
console.log(`icons written to ${outDir}`);
