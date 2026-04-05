/**
 * Camera stream panel logic: decodes JPEG frames via sharp (native async)
 * and renders as ANSI half-block art lines.
 *
 * Uses a single combined decode effect for all cameras to avoid
 * React hooks-in-loop violations. Merges multiple camera panels into
 * single pre-composed <Text> lines so Ink doesn't try to measure ANSI widths.
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Box, Text } from "ink";
import sharp from "sharp";
import { renderToAnsiLines } from "../lib/ansi-renderer.js";
import type { CameraFrame } from "../lib/websocket.js";

/** Decoded camera frame as ANSI lines. */
interface DecodedFrame {
  lines: string[];
}

interface CameraRowProps {
  cameras: Array<{ name: string; frame: CameraFrame | undefined }>;
  panelWidth: number;
  panelHeight: number;
  infoPanelLines?: string[];
}

/**
 * Renders multiple camera panels side-by-side as pre-composed text lines.
 *
 * Instead of using Ink's flexbox (which can't measure ANSI escape codes),
 * this component manually merges each camera's ANSI lines into single
 * combined strings. Each output <Text> contains exactly the right number
 * of visible characters, so Ink's layout stays correct.
 */
export function CameraRow({
  cameras,
  panelWidth,
  panelHeight,
  infoPanelLines,
}: CameraRowProps) {
  const contentWidth = Math.max(1, panelWidth - 2);
  const contentCharHeight = Math.max(1, panelHeight - 2);
  const targetPixelWidth = Math.max(1, contentWidth);
  const targetPixelHeight = Math.max(2, contentCharHeight * 2);

  // Track decoded frames for all cameras in a single state object
  const [decodedFrames, setDecodedFrames] = useState<
    Map<string, DecodedFrame>
  >(() => new Map());
  const lastJpegsRef = useRef<Map<string, Buffer | null>>(new Map());
  const seqRef = useRef(0);

  // Single effect that decodes all cameras
  useEffect(() => {
    let cancelled = false;

    for (const cam of cameras) {
      const jpegData = cam.frame?.jpegData ?? null;
      const lastJpeg = lastJpegsRef.current.get(cam.name) ?? null;

      // Skip if same buffer reference
      if (jpegData === lastJpeg) continue;
      lastJpegsRef.current.set(cam.name, jpegData);

      if (!jpegData || jpegData.length === 0) {
        setDecodedFrames((prev) => {
          const next = new Map(prev);
          next.delete(cam.name);
          return next;
        });
        continue;
      }

      const camName = cam.name;
      const seq = ++seqRef.current;

      sharp(jpegData)
        .resize(targetPixelWidth, targetPixelHeight, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => {
          if (cancelled) return;
          const lines = renderToAnsiLines(data, info.width, info.height);
          setDecodedFrames((prev) => {
            const next = new Map(prev);
            next.set(camName, { lines });
            return next;
          });
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [cameras, targetPixelWidth, targetPixelHeight]);

  // Build merged output lines
  const outputLines = useMemo(() => {
    const result: string[] = [];

    // Top border line
    let topLine = "";
    for (let c = 0; c < cameras.length; c++) {
      const name = cameras[c].name;
      const headerText = `── ${name} `;
      const pad = Math.max(0, panelWidth - headerText.length - 1);
      topLine +=
        headerText + "─".repeat(pad) + (c < cameras.length - 1 ? "┬" : "");
    }
    result.push(topLine);

    // Content lines
    for (let row = 0; row < contentCharHeight; row++) {
      let line = "";
      for (let c = 0; c < cameras.length; c++) {
        const decoded = decodedFrames.get(cameras[c].name);
        if (decoded && row < decoded.lines.length) {
          line += decoded.lines[row];
        } else {
          // Placeholder line
          if (row === Math.floor(contentCharHeight / 2)) {
            const msg = "╌ No signal ╌";
            const pad = Math.max(0, contentWidth - msg.length);
            const left = Math.floor(pad / 2);
            const right = pad - left;
            line += " ".repeat(left) + msg + " ".repeat(right);
          } else {
            line += " ".repeat(contentWidth);
          }
        }
        // Reset + separator between cameras
        if (c < cameras.length - 1) {
          line += "\x1b[0m│";
        } else {
          line += "\x1b[0m";
        }
      }
      result.push(line);
    }

    // Bottom border line
    let bottomLine = "";
    for (let c = 0; c < cameras.length; c++) {
      bottomLine +=
        "─".repeat(panelWidth) + (c < cameras.length - 1 ? "┴" : "");
    }
    result.push(bottomLine);

    return result;
  }, [cameras, decodedFrames, panelWidth, contentCharHeight, contentWidth]);

  // Merge info panel lines on the right if provided
  const finalLines = useMemo(() => {
    if (!infoPanelLines || infoPanelLines.length === 0) return outputLines;

    return outputLines.map((line, i) => {
      const infoLine = i < infoPanelLines.length ? infoPanelLines[i] : "";
      return line + infoLine;
    });
  }, [outputLines, infoPanelLines]);

  return (
    <Box flexDirection="column">
      {finalLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
