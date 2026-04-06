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
import {
  incrementGauge,
  nowMs,
  recordTiming,
  setGauge,
} from "../lib/debug-metrics.js";

const RESET = "\x1b[0m";
const DECODE_COMMIT_INTERVAL_MS = 16;
const SHARP_DECODE_CONCURRENCY = 6;
const TARGET_TOTAL_DECODE_FPS = 360;
const MAX_DECODE_FPS_PER_CAMERA = 60;
const MIN_DECODE_FPS_PER_CAMERA = 30;

// Keep libvips from scaling CPU usage linearly with camera count.
sharp.concurrency(SHARP_DECODE_CONCURRENCY);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decoded camera frame as ANSI lines. */
interface DecodedFrame {
  lines: string[];
  frameKey: string;
  sourceTimestampNs: number;
  sourceFrameIndex: number;
  /** The pixel width these lines were decoded at. */
  decodedWidth: number;
  /** The pixel height these lines were decoded at. */
  decodedHeight: number;
}

interface PendingDecode {
  key: string;
  jpegData: Buffer;
  sourceTimestampNs: number;
  sourceFrameIndex: number;
  sourceWidth: number;
  sourceHeight: number;
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
  const perCameraDecodeFps = Math.max(
    MIN_DECODE_FPS_PER_CAMERA,
    Math.min(
      MAX_DECODE_FPS_PER_CAMERA,
      Math.floor(TARGET_TOTAL_DECODE_FPS / Math.max(1, numCams)),
    ),
  );
  const perCameraDecodeIntervalMs = 1000 / perCameraDecodeFps;
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
  const decodedFramesRef = useRef<Map<string, DecodedFrame>>(new Map());
  const decodedFramesDirtyRef = useRef(false);
  const committedFrameKeyRef = useRef<Map<string, string>>(new Map());
  const requestedDecodeKeyRef = useRef<Map<string, string>>(new Map());
  const pendingDecodeRef = useRef<Map<string, PendingDecode>>(new Map());
  const activeDecodeRef = useRef<Set<string>>(new Set());
  const lastDecodeStartedAtRef = useRef<Map<string, number>>(new Map());
  const isMountedRef = useRef(true);

  const clearDecodedFrame = (camName: string) => {
    if (!decodedFramesRef.current.has(camName)) return;
    decodedFramesRef.current.delete(camName);
    decodedFramesDirtyRef.current = true;
  };

  useEffect(() => {
    isMountedRef.current = true;
    setGauge("stream.frames_presented_total", 0);
    const flushDecodedFrames = setInterval(() => {
      if (!isMountedRef.current || !decodedFramesDirtyRef.current) return;
      const flushStartMs = nowMs();
      decodedFramesDirtyRef.current = false;
      let presentedFrameCount = 0;
      for (const [camName, decodedFrame] of decodedFramesRef.current) {
        if (committedFrameKeyRef.current.get(camName) === decodedFrame.frameKey) {
          continue;
        }
        committedFrameKeyRef.current.set(camName, decodedFrame.frameKey);
        presentedFrameCount += 1;
        incrementGauge(`stream.frames_presented_total.${camName}`);
        const displayedLatencyMs = Math.max(
          0,
          Date.now() - decodedFrame.sourceTimestampNs / 1_000_000,
        );
        setGauge(`stream.display_latency_ms.${camName}`, displayedLatencyMs);
        setGauge(
          `stream.displayed_source_timestamp_ns.${camName}`,
          decodedFrame.sourceTimestampNs,
        );
        setGauge(`stream.displayed_frame_index.${camName}`, decodedFrame.sourceFrameIndex);
        recordTiming("stream.latency.displayed", displayedLatencyMs);
      }
      for (const camName of Array.from(committedFrameKeyRef.current.keys())) {
        if (!decodedFramesRef.current.has(camName)) {
          committedFrameKeyRef.current.delete(camName);
        }
      }
      setDecodedFrames(new Map(decodedFramesRef.current));
      recordTiming("stream.decode.commit", nowMs() - flushStartMs);
      setGauge("stream.decoded_frames", decodedFramesRef.current.size);
      if (presentedFrameCount > 0) {
        incrementGauge("stream.frames_presented_total", presentedFrameCount);
      }
    }, DECODE_COMMIT_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(flushDecodedFrames);
      decodedFramesRef.current.clear();
      decodedFramesDirtyRef.current = false;
      committedFrameKeyRef.current.clear();
      requestedDecodeKeyRef.current.clear();
      pendingDecodeRef.current.clear();
      activeDecodeRef.current.clear();
      lastDecodeStartedAtRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const black = { r: 0, g: 0, b: 0, alpha: 1 };
    const activeNames = new Set(cameras.map((cam) => cam.name));

    const updateDecodeGauges = () => {
      setGauge("stream.pending_decodes", pendingDecodeRef.current.size);
      setGauge("stream.active_decodes", activeDecodeRef.current.size);
      setGauge("stream.target_width", perCamWidth);
      setGauge("stream.target_height", targetPixelHeight);
      setGauge("stream.target_char_height", contentCharHeight);
      setGauge("stream.target_cells_per_camera", perCamWidth * contentCharHeight);
      setGauge("stream.target_pixels_per_camera", perCamWidth * targetPixelHeight);
      setGauge("stream.decode_fps_cap", perCameraDecodeFps);
      setGauge("stream.decode_interval_ms", perCameraDecodeIntervalMs);
      setGauge("stream.sharp_concurrency", SHARP_DECODE_CONCURRENCY);
    };

    const pumpDecode = (camName: string) => {
      if (activeDecodeRef.current.has(camName)) return;
      const initialPending = pendingDecodeRef.current.get(camName);
      if (!initialPending) return;

      activeDecodeRef.current.add(camName);
      updateDecodeGauges();

      void (async () => {
        try {
          let pending: PendingDecode | undefined = initialPending;

          while (isMountedRef.current && pending) {
            pendingDecodeRef.current.delete(camName);
            updateDecodeGauges();

            try {
              const lastDecodeStartedAt =
                lastDecodeStartedAtRef.current.get(camName);
              if (lastDecodeStartedAt !== undefined) {
                const waitMs =
                  lastDecodeStartedAt + perCameraDecodeIntervalMs - nowMs();
                if (waitMs > 1) {
                  recordTiming("stream.decode.wait", waitMs);
                  await sleep(waitMs);
                  if (!isMountedRef.current) return;

                  const latestPending = pendingDecodeRef.current.get(camName);
                  if (latestPending) {
                    pending = latestPending;
                    pendingDecodeRef.current.delete(camName);
                    updateDecodeGauges();
                  }
                }
              }

              lastDecodeStartedAtRef.current.set(camName, nowMs());
              const totalDecodeStartMs = nowMs();
              const resizeStartMs = nowMs();
              const { data, info } = await sharp(pending.jpegData, {
                sequentialRead: true,
              })
                .resize(perCamWidth, targetPixelHeight, {
                  // Preserve the camera aspect ratio and pad the rest of the panel
                  // instead of stretching the frame to the available space.
                  fit: "contain",
                  position: "centre",
                  background: black,
                  kernel: sharp.kernel.nearest,
                })
                .raw()
                .toBuffer({ resolveWithObject: true });
              const resizeDurationMs = nowMs() - resizeStartMs;

              if (!isMountedRef.current) return;
              if (requestedDecodeKeyRef.current.get(camName) !== pending.key) {
                pending = pendingDecodeRef.current.get(camName);
                continue;
              }

              const ansiStartMs = nowMs();
              const ansiResult = renderToAnsiLines(data, info.width, info.height);
              const ansiDurationMs = nowMs() - ansiStartMs;
              const totalDecodeDurationMs = nowMs() - totalDecodeStartMs;
              recordTiming("stream.decode.resize", resizeDurationMs);
              recordTiming(`stream.decode.resize.${camName}`, resizeDurationMs);
              recordTiming("stream.decode.ansi", ansiDurationMs);
              recordTiming(`stream.decode.ansi.${camName}`, ansiDurationMs);
              recordTiming("stream.decode.total", totalDecodeDurationMs);
              recordTiming(`stream.decode.total.${camName}`, totalDecodeDurationMs);
              setGauge(
                `stream.source_resolution.${camName}`,
                `${pending.sourceWidth}x${pending.sourceHeight}`,
              );
              setGauge(
                `stream.source_pixels.${camName}`,
                pending.sourceWidth * pending.sourceHeight,
              );
              setGauge(`stream.jpeg_bytes.${camName}`, pending.jpegData.length);
              setGauge(
                `stream.decoded_resolution.${camName}`,
                `${info.width}x${info.height}`,
              );
              setGauge(`stream.ansi_cells.${camName}`, ansiResult.cellCount);
              setGauge(
                `stream.ansi_sgr_changes.${camName}`,
                ansiResult.sgrChangeCount,
              );
              setGauge(
                `stream.ansi_sgr_per_cell.${camName}`,
                ansiResult.cellCount > 0
                  ? ansiResult.sgrChangeCount / ansiResult.cellCount
                  : 0,
              );
              decodedFramesRef.current.set(camName, {
                lines: ansiResult.lines,
                frameKey: pending.key,
                sourceTimestampNs: pending.sourceTimestampNs,
                sourceFrameIndex: pending.sourceFrameIndex,
                decodedWidth: info.width,
                decodedHeight: info.height,
              });
              decodedFramesDirtyRef.current = true;
            } catch {
              if (!isMountedRef.current) return;
            }

            pending = pendingDecodeRef.current.get(camName);
          }
        } finally {
          activeDecodeRef.current.delete(camName);
          updateDecodeGauges();
          if (isMountedRef.current && pendingDecodeRef.current.has(camName)) {
            pumpDecode(camName);
          }
        }
      })();
    };

    for (const cam of cameras) {
      const frame = cam.frame;

      if (!frame?.jpegData || frame.jpegData.length === 0) {
        requestedDecodeKeyRef.current.delete(cam.name);
        pendingDecodeRef.current.delete(cam.name);
        clearDecodedFrame(cam.name);
        updateDecodeGauges();
        continue;
      }

      const decodeKey = `${frame.sequence}:${perCamWidth}x${targetPixelHeight}`;
      if (requestedDecodeKeyRef.current.get(cam.name) === decodeKey) {
        continue;
      }

      requestedDecodeKeyRef.current.set(cam.name, decodeKey);
      pendingDecodeRef.current.set(cam.name, {
        key: decodeKey,
        jpegData: frame.jpegData,
        sourceTimestampNs: frame.timestampNs,
        sourceFrameIndex: frame.frameIndex,
        sourceWidth: frame.width,
        sourceHeight: frame.height,
      });
      updateDecodeGauges();
      pumpDecode(cam.name);
    }

    for (const name of Array.from(requestedDecodeKeyRef.current.keys())) {
      if (activeNames.has(name)) continue;
      requestedDecodeKeyRef.current.delete(name);
      pendingDecodeRef.current.delete(name);
      clearDecodedFrame(name);
      updateDecodeGauges();
    }
  }, [
    cameras,
    perCamWidth,
    targetPixelHeight,
    perCameraDecodeFps,
    perCameraDecodeIntervalMs,
  ]);

  useEffect(() => {
    setGauge("stream.rendered_cameras", numCams);
    setGauge("stream.decoded_frames", decodedFrames.size);
    setGauge("stream.target_visible_cells", numCams * perCamWidth * contentCharHeight);
  }, [numCams, decodedFrames.size, perCamWidth, contentCharHeight]);

  // Build merged output lines with proper box-drawing borders
  const outputResult = useMemo(() => {
    const composeStartMs = nowMs();
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

    return {
      lines: result,
      composeDurationMs: nowMs() - composeStartMs,
    };
  }, [cameras, decodedFrames, numCams, perCamWidth, contentCharHeight]);

  useEffect(() => {
    recordTiming("stream.compose", outputResult.composeDurationMs);
  }, [outputResult.composeDurationMs]);

  const outputLines = outputResult.lines;

  // Merge info panel lines on the right if provided
  const finalOutputResult = useMemo(() => {
    const finalizeStartMs = nowMs();
    const finalLines =
      !infoPanelLines || infoPanelLines.length === 0
        ? outputLines.map((line) => line + RESET)
        : outputLines.map((line, i) => {
            const infoLine = i < infoPanelLines.length ? infoPanelLines[i] : "";
            return line + infoLine + RESET;
          });
    const finalText = finalLines.join("\n");
    return {
      finalLines,
      finalText,
      finalizeDurationMs: nowMs() - finalizeStartMs,
      outputBytes: Buffer.byteLength(finalText, "utf8"),
    };
  }, [outputLines, infoPanelLines]);

  useEffect(() => {
    recordTiming("stream.finalize", finalOutputResult.finalizeDurationMs);
    setGauge("stream.output_rows", finalOutputResult.finalLines.length);
    setGauge("stream.output_bytes", finalOutputResult.outputBytes);
  }, [
    finalOutputResult.finalizeDurationMs,
    finalOutputResult.finalLines.length,
    finalOutputResult.outputBytes,
  ]);

  const finalText = finalOutputResult.finalText;

  return (
    <Box flexDirection="column">
      <Text wrap="end">{finalText}</Text>
    </Box>
  );
}
