import { readFile } from "node:fs/promises";
import { nowMs } from "../debug-metrics.js";
import { HarriGeometry } from "./harri-geometry.js";
import type {
  AsciiRenderInput,
  AsciiRenderLayout,
  AsciiRenderResult,
  AsciiRendererBackend,
  AsciiRendererOptions,
  AsciiRasterDimensions,
} from "./types.js";

interface HarriWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(ptr: number, len: number, cap: number): void;
  renderer_create(cellWidth: number, cellHeight: number): number;
  renderer_destroy(handle: number): void;
  renderer_render(
    handle: number,
    pixelsPtr: number,
    pixelsLen: number,
    width: number,
    height: number,
    columns: number,
    rows: number,
  ): number;
  renderer_output_ptr(handle: number): number;
  renderer_output_len(handle: number): number;
  renderer_sgr_change_count(handle: number): number;
  renderer_cache_hits(handle: number): number;
  renderer_cache_misses(handle: number): number;
  renderer_sample_count(handle: number): number;
  renderer_lookup_count(handle: number): number;
  renderer_total_ms(handle: number): number;
  renderer_sample_ms(handle: number): number;
  renderer_lookup_ms(handle: number): number;
  renderer_assemble_ms(handle: number): number;
  last_error_ptr(): number;
  last_error_len(): number;
}

interface WasmAllocation {
  ptr: number;
  len: number;
  cap: number;
}

interface RustWasmHarriRendererOptions {
  rendererId?: string;
  label?: string;
}

const UTF8_DECODER = new TextDecoder();
let wasmExportsPromise: Promise<HarriWasmExports> | null = null;

function resolveHarriWasmUrl(): URL {
  return new URL("../../../wasm/harri-core.wasm", import.meta.url);
}

async function loadHarriWasmExports(): Promise<HarriWasmExports> {
  if (!wasmExportsPromise) {
    wasmExportsPromise = (async () => {
      const wasmBytes = await readFile(resolveHarriWasmUrl());
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      return instance.exports as unknown as HarriWasmExports;
    })();
  }
  return await wasmExportsPromise;
}

function allocateBytes(exports: HarriWasmExports, bytes: Uint8Array): WasmAllocation {
  if (bytes.byteLength === 0) {
    return { ptr: 0, len: 0, cap: 0 };
  }
  const ptr = exports.alloc(bytes.byteLength);
  new Uint8Array(exports.memory.buffer, ptr, bytes.byteLength).set(bytes);
  return {
    ptr,
    len: bytes.byteLength,
    cap: bytes.byteLength,
  };
}

function freeAllocation(exports: HarriWasmExports, allocation: WasmAllocation): void {
  if (allocation.cap === 0) {
    return;
  }
  exports.dealloc(allocation.ptr, allocation.len, allocation.cap);
}

function readLastError(exports: HarriWasmExports): Error {
  const ptr = exports.last_error_ptr();
  const len = exports.last_error_len();
  if (len <= 0) {
    return new Error("Unknown Harri WASM error");
  }
  const bytes = new Uint8Array(exports.memory.buffer, ptr, len).slice();
  return new Error(UTF8_DECODER.decode(bytes));
}

export class RustWasmHarriRenderer implements AsciiRendererBackend {
  readonly kind = "wasm" as const;
  readonly algorithm = "shape-lookup-rust-wasm";
  readonly pixelFormat = "luma8" as const;
  readonly id: string;
  readonly label: string;

  private readonly geometry: HarriGeometry;
  private exports: HarriWasmExports | null = null;
  private handle = 0;

  constructor(
    options: AsciiRendererOptions = {},
    {
      rendererId = "wasm-harri",
      label = "Harri (WASM)",
    }: RustWasmHarriRendererOptions = {},
  ) {
    this.id = rendererId;
    this.label = label;
    this.geometry = new HarriGeometry(options);
  }

  describeRaster(layout: AsciiRenderLayout): AsciiRasterDimensions {
    return this.geometry.describeRaster(layout);
  }

  layoutForRaster(raster: AsciiRasterDimensions): AsciiRenderLayout {
    return this.geometry.layoutForRaster(raster);
  }

  async prepare(): Promise<void> {
    if (this.handle !== 0 && this.exports) {
      return;
    }

    const exports = await loadHarriWasmExports();
    const handle = exports.renderer_create(this.geometry.cellWidth, this.geometry.cellHeight);
    if (handle === 0) {
      throw readLastError(exports);
    }

    this.exports = exports;
    this.handle = handle;
  }

  async render(input: AsciiRenderInput): Promise<AsciiRenderResult> {
    await this.prepare();
    if (!this.exports || this.handle === 0) {
      throw new Error("Harri WASM renderer not initialized");
    }

    const expected = this.describeRaster(input.layout);
    if (input.width !== expected.width || input.height !== expected.height) {
      throw new Error(
        `${this.id} expected raster ${expected.width}x${expected.height}, received ` +
          `${input.width}x${input.height}`,
      );
    }

    const pixelBytes = new Uint8Array(
      input.pixels.buffer,
      input.pixels.byteOffset,
      input.pixels.byteLength,
    );
    const pixelAllocation = allocateBytes(this.exports, pixelBytes);
    const startedAtMs = nowMs();
    try {
      const ok = this.exports.renderer_render(
        this.handle,
        pixelAllocation.ptr,
        pixelAllocation.len,
        input.width,
        input.height,
        input.layout.columns,
        input.layout.rows,
      );
      if (ok === 0) {
        throw readLastError(this.exports);
      }

      const outputPtr = this.exports.renderer_output_ptr(this.handle);
      const outputLen = this.exports.renderer_output_len(this.handle);
      const outputBytes =
        outputLen > 0
          ? new Uint8Array(this.exports.memory.buffer, outputPtr, outputLen).slice()
          : new Uint8Array();
      const outputText = UTF8_DECODER.decode(outputBytes);

      const backendTotalMs = optionalTiming(this.exports.renderer_total_ms(this.handle));
      return {
        backendId: this.id,
        lines: outputText.length > 0 ? outputText.split("\n") : [],
        stats: {
          rasterWidth: input.width,
          rasterHeight: input.height,
          outputColumns: input.layout.columns,
          outputRows: input.layout.rows,
          outputBytes: outputBytes.byteLength,
          cellCount: input.layout.columns * input.layout.rows,
          sampleCount: this.exports.renderer_sample_count(this.handle),
          lookupCount: this.exports.renderer_lookup_count(this.handle),
          sgrChangeCount: this.exports.renderer_sgr_change_count(this.handle),
          cacheHits: this.exports.renderer_cache_hits(this.handle),
          cacheMisses: this.exports.renderer_cache_misses(this.handle),
          timings: {
            totalMs: backendTotalMs ?? nowMs() - startedAtMs,
            sampleMs: optionalTiming(this.exports.renderer_sample_ms(this.handle)),
            lookupMs: optionalTiming(this.exports.renderer_lookup_ms(this.handle)),
            assembleMs: optionalTiming(this.exports.renderer_assemble_ms(this.handle)),
          },
        },
      };
    } finally {
      freeAllocation(this.exports, pixelAllocation);
    }
  }

  async dispose(): Promise<void> {
    if (!this.exports || this.handle === 0) {
      return;
    }
    this.exports.renderer_destroy(this.handle);
    this.handle = 0;
  }
}

function optionalTiming(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
