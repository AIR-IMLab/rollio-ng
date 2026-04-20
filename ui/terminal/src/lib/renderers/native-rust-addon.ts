import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AsciiPixelFormat, AsciiRasterDimensions, AsciiRenderLayout } from "./types.js";

export interface NativeAsciiAddonModule {
  pixelFormatForAlgorithm: (algorithmId: string) => AsciiPixelFormat;
  describeRasterForAlgorithm: (
    algorithmId: string,
    cellAspect: number,
    columns: number,
    rows: number,
  ) => AsciiRasterDimensions;
  layoutForRasterForAlgorithm: (
    algorithmId: string,
    cellAspect: number,
    width: number,
    height: number,
  ) => AsciiRenderLayout;
  NativeAsciiRenderer: new (algorithmId: string, cellAspect: number) => {
    render(
      pixels: Uint8Array,
      width: number,
      height: number,
      columns: number,
      rows: number,
    ): {
      lines: string[];
      stats: {
        totalMs: number;
        sampleMs?: number;
        lookupMs?: number;
        sampleCount: number;
        lookupCount: number;
        cacheHits: number;
        cacheMisses: number;
        cellCount: number;
        outputBytes: number;
        sgrChangeCount?: number;
        assembleMs?: number;
      };
    };
  };
}

function resolveNativeAsciiAddonUrl(): URL {
  // tsx (dev) runs this file as src/lib/renderers/native-rust-addon.ts, so the
  // addon is three levels up. The production bundle inlines this module into
  // dist/index.js and dist/native-rust.worker.js, where the addon is one level
  // up at ../native/.
  if (import.meta.url.endsWith(".ts")) {
    return new URL("../../../native/rollio-native-ascii.node", import.meta.url);
  }
  return new URL("../native/rollio-native-ascii.node", import.meta.url);
}

export function loadNativeAsciiAddon(): NativeAsciiAddonModule {
  const addonPath = fileURLToPath(resolveNativeAsciiAddonUrl());
  if (!existsSync(addonPath)) {
    throw new Error(`Native ASCII addon not found at ${addonPath}`);
  }
  const require = createRequire(import.meta.url);
  return require(addonPath) as NativeAsciiAddonModule;
}
