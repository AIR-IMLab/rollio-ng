import {
  WorkerThreadNativeRustRenderer,
  type NativeAsciiRendererPreset,
} from "./native-rust.js";
import type { AsciiRendererBackend, AsciiRendererOptions } from "./types.js";

export const ASCII_RENDERER_IDS = [
  "native-rust",
  "native-rust-color",
  "ts-half-block",
] as const;

export type AsciiRendererId = (typeof ASCII_RENDERER_IDS)[number];

const ASCII_RENDERER_PRESETS: Record<AsciiRendererId, NativeAsciiRendererPreset> = {
  "native-rust": {
    id: "native-rust",
    label: "Context Shape",
    algorithmId: "context_shape",
  },
  "native-rust-color": {
    id: "native-rust-color",
    label: "Context Shape Color",
    algorithmId: "context_shape_color",
  },
  "ts-half-block": {
    id: "ts-half-block",
    label: "Half Block",
    algorithmId: "half_block_color",
  },
};

export function createAsciiRendererBackend(
  id: AsciiRendererId,
  options: AsciiRendererOptions = {},
): AsciiRendererBackend {
  return new WorkerThreadNativeRustRenderer(ASCII_RENDERER_PRESETS[id], options);
}

export function listAsciiRendererBackends(): AsciiRendererBackend[] {
  return ASCII_RENDERER_IDS.map((id) => createAsciiRendererBackend(id));
}

export function defaultAsciiRendererId(): AsciiRendererId {
  const selected = process.env.ROLLIO_ASCII_RENDERER;
  if (selected && isAsciiRendererId(selected)) {
    return selected;
  }
  return "native-rust";
}

export function isAsciiRendererId(value: string): value is AsciiRendererId {
  return (ASCII_RENDERER_IDS as readonly string[]).includes(value);
}

export function nextAsciiRendererId(current: AsciiRendererId): AsciiRendererId {
  const currentIndex = ASCII_RENDERER_IDS.indexOf(current);
  const nextIndex = (currentIndex + 1) % ASCII_RENDERER_IDS.length;
  return ASCII_RENDERER_IDS[nextIndex] ?? ASCII_RENDERER_IDS[0];
}

export function getAsciiRendererLabel(id: AsciiRendererId): string {
  return ASCII_RENDERER_PRESETS[id].label;
}

export type {
  AsciiPixelFormat,
  AsciiCellGeometry,
  AsciiRenderInput,
  AsciiRenderLayout,
  AsciiRenderResult,
  AsciiRenderStats,
  AsciiRenderTimings,
  AsciiRendererBackend,
  AsciiRendererOptions,
  AsciiRasterDimensions,
} from "./types.js";
