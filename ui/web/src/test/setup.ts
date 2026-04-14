import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, vi } from "vitest";
import { resetDebugMetrics } from "../lib/debug-metrics";

class MockResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          borderBoxSize: [] as ResizeObserverSize[],
          contentBoxSize: [] as ResizeObserverSize[],
          contentRect: target.getBoundingClientRect(),
          devicePixelContentBoxSize: [] as ResizeObserverSize[],
        },
      ] as ResizeObserverEntry[],
      this,
    );
  }

  unobserve(_target: Element): void {}

  disconnect(): void {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: MockResizeObserver,
  });

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.testWidth ?? 320);
    },
  });

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.testHeight ?? 180);
    },
  });

  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
  }
  if (!("revokeObjectURL" in URL)) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  cleanup();
  resetDebugMetrics();
  vi.restoreAllMocks();
});
