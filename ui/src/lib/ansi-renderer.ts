/**
 * ANSI half-block renderer: converts raw RGB pixels into ANSI 256-color
 * terminal art using the lower half-block character (▄ U+2584).
 *
 * Each terminal character cell represents 1 column × 2 rows of pixels:
 * - Background color → top pixel
 * - Foreground color → bottom pixel
 * - Character → ▄ (lower half block)
 *
 * Optimizations:
 * - O(1) color lookup via pre-computed LUT (color-palette.ts)
 * - Batches same-color runs to reduce escape code count
 */

import { nearestAnsi256 } from "./color-palette.js";

const HALF_BLOCK = "\u2584";
const RESET = "\x1b[0m";

/**
 * Render RGB pixel data as an array of ANSI 256-color half-block lines.
 *
 * Returns one string per character row (no newlines within strings).
 * Each string contains exactly `imgWidth` visible characters plus
 * invisible ANSI escape sequences.
 *
 * @param rgbPixels - Raw RGB24 pixel data (3 bytes per pixel, row-major)
 * @param imgWidth  - Width of the image in pixels
 * @param imgHeight - Height of the image in pixels (should be even)
 * @returns Array of ANSI-escaped strings, one per character row
 */
export function renderToAnsiLines(
  rgbPixels: Buffer | Uint8Array,
  imgWidth: number,
  imgHeight: number,
): string[] {
  const charRows = Math.floor(imgHeight / 2);
  if (charRows === 0 || imgWidth === 0) return [];

  const lines: string[] = [];

  for (let cy = 0; cy < charRows; cy++) {
    const topRowY = cy * 2;
    const botRowY = cy * 2 + 1;
    const parts: string[] = [];

    let prevBg = -1;
    let prevFg = -1;

    for (let x = 0; x < imgWidth; x++) {
      const topIdx = (topRowY * imgWidth + x) * 3;
      const bgAnsi = nearestAnsi256(
        rgbPixels[topIdx],
        rgbPixels[topIdx + 1],
        rgbPixels[topIdx + 2],
      );

      const botIdx = (botRowY * imgWidth + x) * 3;
      const fgAnsi = nearestAnsi256(
        rgbPixels[botIdx],
        rgbPixels[botIdx + 1],
        rgbPixels[botIdx + 2],
      );

      if (bgAnsi !== prevBg && fgAnsi !== prevFg) {
        parts.push(`\x1b[48;5;${bgAnsi};38;5;${fgAnsi}m${HALF_BLOCK}`);
      } else if (bgAnsi !== prevBg) {
        parts.push(`\x1b[48;5;${bgAnsi}m${HALF_BLOCK}`);
      } else if (fgAnsi !== prevFg) {
        parts.push(`\x1b[38;5;${fgAnsi}m${HALF_BLOCK}`);
      } else {
        parts.push(HALF_BLOCK);
      }

      prevBg = bgAnsi;
      prevFg = fgAnsi;
    }

    parts.push(RESET);
    lines.push(parts.join(""));
  }

  return lines;
}
