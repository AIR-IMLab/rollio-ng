import type { WebSocketLike } from "../lib/websocket";

export class FakeWebSocket extends EventTarget implements WebSocketLike {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

export function createFakeWebSocketFactory() {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    factory(url: string) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}
