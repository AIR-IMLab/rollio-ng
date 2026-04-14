import { render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createFakeWebSocketFactory } from "./test/fake-websocket";

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("switches between wide and narrow layouts", () => {
    setViewport(1300, 900);
    const { container } = render(
      <App
        runtimeConfig={{
          websocketUrl: "ws://127.0.0.1:9090",
          episodeKeyBindings: {
            startKey: "s",
            stopKey: "e",
            keepKey: "k",
            discardKey: "x",
          },
        }}
        webSocketOptions={{
          websocketFactory: createFakeWebSocketFactory().factory,
          objectUrlFactory: () => "blob:mock",
          revokeObjectUrl: vi.fn(),
        }}
      />,
    );

    expect(container.querySelector(".camera-layout--wide")).not.toBeNull();

    act(() => {
      setViewport(900, 900);
      window.dispatchEvent(new Event("resize"));
    });

    expect(container.querySelector(".camera-layout--narrow")).not.toBeNull();
  });

  it("toggles debug mode and negotiates preview size over websocket", async () => {
    vi.useFakeTimers();
    setViewport(1300, 900);
    const { sockets, factory } = createFakeWebSocketFactory();

    render(
      <App
        runtimeConfig={{
          websocketUrl: "ws://127.0.0.1:9090",
          episodeKeyBindings: {
            startKey: "s",
            stopKey: "e",
            keepKey: "k",
            discardKey: "x",
          },
        }}
        webSocketOptions={{
          websocketFactory: factory,
          objectUrlFactory: () => "blob:mock",
          revokeObjectUrl: vi.fn(),
        }}
      />,
    );

    await act(async () => {
      sockets[0].open();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(sockets[0].sent).toContain(
      JSON.stringify({ type: "command", action: "get_stream_info" }),
    );
    expect(
      sockets[0].sent.some((message) => {
        const parsed = JSON.parse(message) as {
          type: string;
          action: string;
          width?: number;
          height?: number;
        };
        return (
          parsed.type === "command" &&
          parsed.action === "set_preview_size" &&
          typeof parsed.width === "number" &&
          parsed.width > 0 &&
          typeof parsed.height === "number" &&
          parsed.height > 0
        );
      }),
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    });
    expect(screen.getByText(/Debug \(press d to hide\)/)).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    });
    expect(sockets[0].sent).toContain(
      JSON.stringify({ type: "command", action: "episode_start" }),
    );
  });
});
