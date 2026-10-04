import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

// Pixels in rows, from the top left. Each pixel has 1 (gray), 3 (RGB), or 4 (RGBA) bytes.
export interface Pixels {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

// The longest side of an image for the model. The providers make a larger image smaller anyway,
// and a smaller file is faster to send.
export const MAX_IMAGE_SIDE = 1568;

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 } as const;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type));
  body.set(data, 4);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return result;
}

// Encode pixels as a PNG file. Each row uses the "Up" filter, which compresses screenshots well.
export function encodePng(pixels: Pixels): Uint8Array {
  const { width, height, channels, data } = pixels;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, COLOR_TYPE[channels], 0, 0, 0], 8);

  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 2;
    for (let x = 0; x < stride; x++) {
      const value = data[y * stride + x]!;
      const above = y > 0 ? data[(y - 1) * stride + x]! : 0;
      raw[out + 1 + x] = (value - above) & 0xff;
    }
  }
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Make an image smaller, so that its longest side is at most maxSide. Each new pixel is the average of the pixels that it covers.
export function shrink(pixels: Pixels, maxSide = MAX_IMAGE_SIDE): Pixels {
  const { width, height, channels, data } = pixels;
  const scale = maxSide / Math.max(width, height);
  if (scale >= 1) return pixels;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const result = new Uint8Array(newWidth * newHeight * channels);
  for (let y = 0; y < newHeight; y++) {
    const top = Math.floor((y * height) / newHeight);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const left = Math.floor((x * width) / newWidth);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / newWidth));
      const count = (bottom - top) * (right - left);
      for (let c = 0; c < channels; c++) {
        let total = 0;
        for (let sy = top; sy < bottom; sy++) {
          for (let sx = left; sx < right; sx++) total += data[(sy * width + sx) * channels + c]!;
        }
        result[(y * newWidth + x) * channels + c] = Math.round(total / count);
      }
    }
  }
  return { width: newWidth, height: newHeight, channels, data: result };
}

// The id of an image: a hash of its bytes. The same image gets the same id in each parse.
export function imageId(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}
