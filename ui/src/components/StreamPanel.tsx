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
  /** The pixel width these lines were decoded at. */
  decodedWidth: number;
  /** The pixel height these lines were decoded at. */
  decodedHeight: number;
}

interface CameraRowProps {
  cameras: Array<{ name: string; frame: CameraFrame | undefined }>;
  /** Total width available for ALL cameras combined (excluding info panel). */
  totalWidth: number;
  panelHeight: number;
  infoPanelLines?: string[];
  /** If true, the right border connects to an adjacent info panel. */
  hasRightPanel?: boolean;
}

/**
 * Renders multiple camera panels side-by-side as pre-composed text lines.
 *
 * Instead of using Ink's flexbox (which can't measure ANSI escape codes),
 * this component manually merges each camera's ANSI lines into single
 * combined strings with proper box-drawing borders.
 *
 * Width math (visible chars):
 *   totalWidth includes the outer left │ and outer right │.
 *   With N cameras and (N-1) inner separator │ chars plus 2 outer │:
 *   perCameraContentWidth = floor((totalWidth - 2 - (N-1)) / N)
 */
export function CameraRow({
  cameras,
  totalWidth,
  panelHeight,
  infoPanelLines,
  hasRightPanel = false,
}: CameraRowProps) {
  const numCams = cameras.length;
  // 2 for outer borders, (numCams-1) for inner separators
  const innerSeparators = numCams - 1;
  const perCamWidth = Math.max(
    4,
    Math.floor((totalWidth - 2 - innerSeparators) / numCams),
  );
  const contentCharHeight = Math.max(1, panelHeight - 2); // minus top/bottom border
  const targetPixelHeight = Math.max(2, contentCharHeight * 2); // ×2 for half-block

  // Track decoded frames for all cameras
  const [decodedFrames, setDecodedFrames] = useState<Map<string, DecodedFrame>>(
    () => new Map(),
  );
  // Track last JPEG data AND dimensions to trigger re-decode on resize
  const lastDecodeKeyRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    for (const cam of cameras) {
      const jpegData = cam.frame?.jpegData ?? null;

      // Build a decode key that includes dimensions so resize triggers re-decode
      const dataId = jpegData ? `${jpegData.length}:${jpegData[0]}:${jpegData[jpegData.length - 1]}` : "null";
      const decodeKey = `${dataId}:${perCamWidth}x${targetPixelHeight}`;
      const lastKey = lastDecodeKeyRef.current.get(cam.name);

      if (decodeKey === lastKey) continue;
      lastDecodeKeyRef.current.set(cam.name, decodeKey);

      if (!jpegData || jpegData.length === 0) {
        setDecodedFrames((prev) => {
          const next = new Map(prev);
          next.delete(cam.name);
          return next;
        });
        continue;
      }

      const camName = cam.name;

      sharp(jpegData)
        .resize(perCamWidth, targetPixelHeight, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => {
          if (cancelled) return;
          const lines = renderToAnsiLines(data, info.width, info.height);
          setDecodedFrames((prev) => {
            const next = new Map(prev);
            next.set(camName, {
              lines,
              decodedWidth: perCamWidth,
              decodedHeight: targetPixelHeight,
            });
            return next;
          });
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [cameras, perCamWidth, targetPixelHeight]);

  // Build merged output lines with proper box-drawing borders
  const outputLines = useMemo(() => {
    const result: string[] = [];

    // Right-edge chars depend on whether an info panel is attached
    const topRight = hasRightPanel ? "┬" : "┐";
    const midRight = hasRightPanel ? "│" : "│";
    const botRight = hasRightPanel ? "┴" : "┘";

    // === Top border: ┌─ camera_0 ─┬─ camera_1 ─┐  (or ┬ if info panel) ===
    let topLine = "┌";
    for (let c = 0; c < numCams; c++) {
      const name = cameras[c].name;
      const label = `─ ${name} `;
      const remaining = Math.max(0, perCamWidth - label.length);
      topLine += label + "─".repeat(remaining);
      topLine += c < numCams - 1 ? "┬" : topRight;
    }
    result.push(topLine);

    // === Content lines: │<ansi>│<ansi>│ ===
    for (let row = 0; row < contentCharHeight; row++) {
      let line = "│";
      for (let c = 0; c < numCams; c++) {
        const decoded = decodedFrames.get(cameras[c].name);
        if (decoded && row < decoded.lines.length) {
          line += decoded.lines[row] + "\x1b[0m";
        } else {
          if (row === Math.floor(contentCharHeight / 2)) {
            const msg = "╌ No signal ╌";
            const pad = Math.max(0, perCamWidth - msg.length);
            const left = Math.floor(pad / 2);
            const right = pad - left;
            line += " ".repeat(left) + msg + " ".repeat(right);
          } else {
            line += " ".repeat(perCamWidth);
          }
        }
        line += c < numCams - 1 ? "│" : midRight;
      }
      result.push(line);
    }

    // === Bottom border: └──────┴──────┘  (or ┴ if info panel) ===
    let bottomLine = "└";
    for (let c = 0; c < numCams; c++) {
      bottomLine += "─".repeat(perCamWidth);
      bottomLine += c < numCams - 1 ? "┴" : botRight;
    }
    result.push(bottomLine);

    return result;
  }, [cameras, decodedFrames, numCams, perCamWidth, contentCharHeight]);

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
