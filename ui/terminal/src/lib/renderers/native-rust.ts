import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { loadNativeAsciiAddon, type NativeAsciiAddonModule } from "./native-rust-addon.js";
import {
  DEFAULT_ASCII_CELL_GEOMETRY,
  assertExpectedRaster,
  type AsciiCellGeometry,
  type AsciiRenderInput,
  type AsciiRenderLayout,
  type AsciiPixelFormat,
  type AsciiRenderResult,
  type AsciiRendererBackend,
  type AsciiRendererOptions,
  type AsciiRasterDimensions,
} from "./types.js";

type NativeAsciiWorkerRequest =
  | {
      type: "init";
      backendId: string;
      algorithmId: string;
      cellAspect: number;
    }
  | {
      type: "render";
      requestId: number;
      input: {
        pixels: Uint8Array;
        width: number;
        height: number;
        layout: AsciiRenderLayout;
      };
    };

type NativeAsciiWorkerResponse =
  | { type: "ready" }
  | { type: "renderResult"; requestId: number; result: AsciiRenderResult }
  | { type: "error"; requestId?: number; message: string; stack?: string };

interface PendingRenderRequest {
  resolve: (result: AsciiRenderResult) => void;
  reject: (reason?: unknown) => void;
  startedAtMs: number;
}

export interface NativeAsciiRendererPreset {
  id: string;
  label: string;
  algorithmId: string;
}

function nowMs(): number {
  return performance.now();
}

function createError(message: string, stack?: string): Error {
  const error = new Error(message);
  if (stack) {
    error.stack = stack;
  }
  return error;
}

function cloneTransferablePixels(pixels: Buffer | Uint8Array): Uint8Array {
  const copy = new Uint8Array(pixels.byteLength);
  copy.set(pixels);
  return copy;
}

let cachedAddon: NativeAsciiAddonModule | null = null;

function getNativeAsciiAddon(): NativeAsciiAddonModule {
  cachedAddon ??= loadNativeAsciiAddon();
  return cachedAddon;
}

function normalizeCellGeometry(geometry?: AsciiCellGeometry): AsciiCellGeometry {
  const candidate = geometry ?? DEFAULT_ASCII_CELL_GEOMETRY;
  return {
    pixelWidth:
      Number.isFinite(candidate.pixelWidth) && candidate.pixelWidth > 0
        ? candidate.pixelWidth
        : DEFAULT_ASCII_CELL_GEOMETRY.pixelWidth,
    pixelHeight:
      Number.isFinite(candidate.pixelHeight) && candidate.pixelHeight > 0
        ? candidate.pixelHeight
        : DEFAULT_ASCII_CELL_GEOMETRY.pixelHeight,
  };
}

function resolveCellAspect(geometry?: AsciiCellGeometry): number {
  const normalized = normalizeCellGeometry(geometry);
  return normalized.pixelHeight / normalized.pixelWidth;
}

function resolveWorkerModuleUrl(): URL {
  // Bundled production: this module is inlined into dist/index.js, and the
  // worker entry sits next to it as dist/native-rust.worker.js.
  if (!import.meta.url.endsWith(".ts")) {
    return new URL("./native-rust.worker.js", import.meta.url);
  }

  // tsx (dev): prefer the previously-built bundle worker if it exists, else
  // fall back to running the .ts source through tsx in the worker thread.
  const builtWorkerUrl = new URL("../../../dist/native-rust.worker.js", import.meta.url);
  if (existsSync(fileURLToPath(builtWorkerUrl))) {
    return builtWorkerUrl;
  }

  return new URL("./native-rust.worker.ts", import.meta.url);
}

export class WorkerThreadNativeRustRenderer implements AsciiRendererBackend {
  readonly id: string;
  readonly label: string;
  readonly kind = "worker" as const;
  readonly algorithm: string;
  readonly pixelFormat: AsciiPixelFormat;

  private readonly cellAspect: number;
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolver:
    | {
        resolve: () => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;
  private readonly pendingRequests = new Map<number, PendingRenderRequest>();
  private nextRequestId = 1;
  private disposed = false;
  private terminatingWorker = false;

  constructor(
    preset: NativeAsciiRendererPreset,
    options: AsciiRendererOptions = {},
  ) {
    this.id = preset.id;
    this.label = preset.label;
    this.algorithm = preset.algorithmId;
    this.cellAspect = resolveCellAspect(options.cellGeometry);
    this.pixelFormat = getNativeAsciiAddon().pixelFormatForAlgorithm(this.algorithm);
  }

  describeRaster(layout: AsciiRenderLayout): AsciiRasterDimensions {
    return getNativeAsciiAddon().describeRasterForAlgorithm(
      this.algorithm,
      this.cellAspect,
      layout.columns,
      layout.rows,
    );
  }

  layoutForRaster(raster: AsciiRasterDimensions): AsciiRenderLayout {
    return getNativeAsciiAddon().layoutForRasterForAlgorithm(
      this.algorithm,
      this.cellAspect,
      raster.width,
      raster.height,
    );
  }

  async prepare(): Promise<void> {
    await this.ensureWorkerReady();
  }

  async render(input: AsciiRenderInput): Promise<AsciiRenderResult> {
    assertExpectedRaster(this, input.width, input.height, input.layout);
    await this.ensureWorkerReady();
    return await this.renderInWorker(input);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.worker) {
      return;
    }

    this.terminatingWorker = true;
    const worker = this.worker;
    this.clearWorkerState();
    this.rejectAllPending(new Error("Native ASCII renderer disposed"));
    await worker.terminate();
  }

  private async ensureWorkerReady(): Promise<void> {
    if (this.disposed) {
      throw new Error("Native ASCII renderer already disposed");
    }

    if (!this.readyPromise) {
      this.readyPromise = this.startWorker();
    }

    await this.readyPromise;
  }

  private async startWorker(): Promise<void> {
    const workerUrl = resolveWorkerModuleUrl();
    const worker = new Worker(workerUrl);
    this.worker = worker;
    this.terminatingWorker = false;

    worker.on("message", (message: NativeAsciiWorkerResponse) => {
      this.handleWorkerMessage(message);
    });
    worker.on("error", (error) => {
      this.handleWorkerFailure(error);
    });
    worker.on("exit", (code) => {
      if (!this.terminatingWorker && !this.disposed && code !== 0) {
        this.handleWorkerFailure(
          new Error(`Native ASCII worker exited unexpectedly with code ${code}`),
        );
      } else {
        this.clearWorkerState();
      }
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = { resolve, reject };
    });
    void readyPromise.catch(() => undefined);

    const initMessage: NativeAsciiWorkerRequest = {
      type: "init",
      backendId: this.id,
      algorithmId: this.algorithm,
      cellAspect: this.cellAspect,
    };
    worker.postMessage(initMessage);
    await readyPromise;
  }

  private async renderInWorker(input: AsciiRenderInput): Promise<AsciiRenderResult> {
    const worker = this.worker;
    if (!worker) {
      throw new Error("Native ASCII worker is not available");
    }

    const pixels = cloneTransferablePixels(input.pixels);
    const requestId = this.nextRequestId++;
    const startedAtMs = nowMs();

    const requestPromise = new Promise<AsciiRenderResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        startedAtMs,
      });
    });
    void requestPromise.catch(() => undefined);

    const message: NativeAsciiWorkerRequest = {
      type: "render",
      requestId,
      input: {
        pixels,
        width: input.width,
        height: input.height,
        layout: input.layout,
      },
    };
    const transferBuffer = pixels.buffer;
    if (transferBuffer instanceof ArrayBuffer) {
      worker.postMessage(message, [transferBuffer]);
    } else {
      worker.postMessage(message);
    }

    return await requestPromise;
  }

  private handleWorkerMessage(message: NativeAsciiWorkerResponse): void {
    switch (message.type) {
      case "ready":
        this.readyResolver?.resolve();
        this.readyResolver = null;
        return;
      case "renderResult": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(message.requestId);
        const roundtripMs = nowMs() - pending.startedAtMs;
        pending.resolve({
          ...message.result,
          stats: {
            ...message.result.stats,
            timings: {
              ...message.result.stats.timings,
              adapterMs: Math.max(0, roundtripMs - message.result.stats.timings.totalMs),
            },
          },
        });
        return;
      }
      case "error": {
        const error = createError(message.message, message.stack);
        if (message.requestId === undefined) {
          this.handleWorkerFailure(error);
          return;
        }
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(message.requestId);
        pending.reject(error);
        return;
      }
    }
  }

  private handleWorkerFailure(error: Error): void {
    if (this.disposed) {
      return;
    }

    this.readyResolver?.reject(error);
    this.readyResolver = null;
    this.readyPromise = null;

    const worker = this.worker;
    this.clearWorkerState();
    this.rejectAllPending(error);
    void worker?.terminate().catch(() => undefined);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearWorkerState(): void {
    this.worker = null;
    this.readyPromise = null;
    this.readyResolver = null;
    this.terminatingWorker = false;
  }
}
