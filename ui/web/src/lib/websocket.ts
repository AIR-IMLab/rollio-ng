import { useCallback, useEffect, useRef, useState } from "react";
import {
  encodeCommand,
  parseBinaryMessage,
  parseJsonMessage,
  type EpisodeStatusMessage,
  type RobotStateMessage,
  type StreamInfoMessage,
} from "./protocol";
import {
  incrementGauge,
  nowMs,
  recordTiming,
  setGauge,
} from "./debug-metrics";

export interface CameraFrame {
  objectUrl: string;
  previewWidth: number;
  previewHeight: number;
  timestampNs: number;
  frameIndex: number;
  receivedAtWallTimeMs: number;
  sequence: number;
  jpegBytes: number;
}

export interface WebSocketState {
  frames: Map<string, CameraFrame>;
  robotStates: Map<string, RobotStateMessage>;
  streamInfo: StreamInfoMessage | null;
  episodeStatus: EpisodeStatusMessage | null;
  connected: boolean;
  send: (msg: string) => void;
}

export interface WebSocketLike extends EventTarget {
  binaryType: BinaryType;
  readyState: number;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface UseWebSocketOptions {
  websocketFactory?: WebSocketFactory;
  objectUrlFactory?: (jpegData: Uint8Array) => string;
  revokeObjectUrl?: (url: string) => void;
}

const WS_OPEN = 1;
const BATCH_INTERVAL_MS = 16;
const RECONNECT_DELAYS = [1000, 2000, 4000, 10000] as const;

export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
}

function defaultObjectUrlFactory(jpegData: Uint8Array): string {
  const buffer = new Uint8Array(jpegData).buffer;
  return URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url);
}

function defaultRevokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return bytes.buffer;
  }
  if (data instanceof Blob) {
    return await data.arrayBuffer();
  }
  return null;
}

function revokeFrameUrls(
  frames: Map<string, CameraFrame>,
  revokeObjectUrl: (url: string) => void,
): void {
  for (const frame of frames.values()) {
    revokeObjectUrl(frame.objectUrl);
  }
}

export function useWebSocket(
  url: string,
  options: UseWebSocketOptions = {},
): WebSocketState {
  const websocketFactory = options.websocketFactory ?? defaultWebSocketFactory;
  const objectUrlFactory = options.objectUrlFactory ?? defaultObjectUrlFactory;
  const revokeObjectUrl = options.revokeObjectUrl ?? defaultRevokeObjectUrl;

  const [connected, setConnected] = useState(false);
  const [frames, setFrames] = useState<Map<string, CameraFrame>>(() => new Map());
  const [robotStates, setRobotStates] = useState<Map<string, RobotStateMessage>>(
    () => new Map(),
  );
  const [streamInfo, setStreamInfo] = useState<StreamInfoMessage | null>(null);
  const [episodeStatus, setEpisodeStatus] = useState<EpisodeStatusMessage | null>(
    null,
  );

  const framesRef = useRef<Map<string, CameraFrame>>(new Map());
  const robotStatesRef = useRef<Map<string, RobotStateMessage>>(new Map());
  const streamInfoRef = useRef<StreamInfoMessage | null>(null);
  const episodeStatusRef = useRef<EpisodeStatusMessage | null>(null);
  const dirtyRef = useRef(false);
  const wsRef = useRef<WebSocketLike | null>(null);
  const frameSequenceRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const send = useCallback((msg: string) => {
    if (wsRef.current?.readyState === WS_OPEN) {
      wsRef.current.send(msg);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setGauge("ws.connected", "Disconnected");
    setGauge("ws.frames_received_total", 0);
    setGauge("ws.robot_messages_total", 0);
    setGauge("ws.frame_count", 0);
    setGauge("ws.robot_state_count", 0);
    setGauge("ws.stream_info_status", "Unavailable");
    setGauge("ws.episode_status", "Unavailable");

    const flushInterval = window.setInterval(() => {
      if (!dirtyRef.current || !mountedRef.current) {
        return;
      }

      const flushStartMs = nowMs();
      dirtyRef.current = false;
      setFrames(new Map(framesRef.current));
      setRobotStates(new Map(robotStatesRef.current));
      setStreamInfo(streamInfoRef.current);
      setEpisodeStatus(episodeStatusRef.current);
      recordTiming("ws.flush", nowMs() - flushStartMs);
      setGauge("ws.frame_count", framesRef.current.size);
      setGauge("ws.robot_state_count", robotStatesRef.current.size);
    }, BATCH_INTERVAL_MS);

    const streamInfoInterval = window.setInterval(() => {
      if (wsRef.current?.readyState === WS_OPEN) {
        wsRef.current.send(encodeCommand("get_stream_info"));
      }
    }, 1000);

    const scheduleReconnect = () => {
      if (!mountedRef.current) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      const delay = reconnectDelayMs(attempt);
      reconnectAttemptRef.current = attempt + 1;
      setGauge("ws.reconnect_attempt", reconnectAttemptRef.current);
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (!mountedRef.current) {
        return;
      }

      const ws = websocketFactory(url);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      const onOpen = () => {
        if (!mountedRef.current) {
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnected(true);
        setGauge("ws.connected", "Connected");
        setGauge("ws.reconnect_attempt", 0);
        ws.send(encodeCommand("get_stream_info"));
      };

      const onMessage = (event: Event) => {
        void (async () => {
          if (!mountedRef.current) {
            return;
          }

          const messageEvent = event as MessageEvent<unknown>;
          if (typeof messageEvent.data === "string") {
            const parseStartMs = nowMs();
            const msg = parseJsonMessage(messageEvent.data);
            recordTiming("ws.parse.json", nowMs() - parseStartMs);
            if (msg?.type === "robot_state") {
              robotStatesRef.current.set(msg.name, msg);
              dirtyRef.current = true;
              incrementGauge("ws.robot_messages_total");
              setGauge("ws.robot_state_count", robotStatesRef.current.size);
            } else if (msg?.type === "stream_info") {
              streamInfoRef.current = msg;
              dirtyRef.current = true;
              setGauge("ws.stream_info_status", "Ready");
              setGauge("ws.preview_fps_config", msg.configured_preview_fps);
              setGauge(
                "ws.active_preview_size",
                `${msg.active_preview_width}x${msg.active_preview_height}`,
              );
            } else if (msg?.type === "episode_status") {
              episodeStatusRef.current = msg;
              dirtyRef.current = true;
              setGauge("ws.episode_status", msg.state);
              setGauge("ws.episode_count", msg.episode_count);
              setGauge("ws.episode_elapsed_ms", msg.elapsed_ms);
            }
            return;
          }

          const buffer = await toArrayBuffer(messageEvent.data);
          if (!buffer || !mountedRef.current) {
            return;
          }

          const parseStartMs = nowMs();
          const msg = parseBinaryMessage(buffer);
          recordTiming("ws.parse.binary", nowMs() - parseStartMs);
          if (!msg) {
            return;
          }

          const previous = framesRef.current.get(msg.name);
          if (previous) {
            revokeObjectUrl(previous.objectUrl);
          }

          const receivedAtWallTimeMs = Date.now();
          const receiveLatencyMs = Math.max(
            0,
            receivedAtWallTimeMs - msg.timestampNs / 1_000_000,
          );
          const sequence = ++frameSequenceRef.current;
          const objectUrl = objectUrlFactory(msg.jpegData);

          framesRef.current.set(msg.name, {
            objectUrl,
            previewWidth: msg.previewWidth,
            previewHeight: msg.previewHeight,
            timestampNs: msg.timestampNs,
            frameIndex: msg.frameIndex,
            receivedAtWallTimeMs,
            sequence,
            jpegBytes: msg.jpegData.byteLength,
          });
          dirtyRef.current = true;
          incrementGauge("ws.frames_received_total");
          incrementGauge(`ws.frames_received_total.${msg.name}`);
          setGauge("ws.frame_count", framesRef.current.size);
          setGauge(`ws.frame_latency_ms.${msg.name}`, receiveLatencyMs);
          setGauge(`ws.frame_index.${msg.name}`, msg.frameIndex);
          setGauge(`ws.jpeg_bytes.${msg.name}`, msg.jpegData.byteLength);
          recordTiming("ws.frame_latency.receive", receiveLatencyMs);
        })();
      };

      const onClose = () => {
        if (!mountedRef.current) {
          return;
        }
        setConnected(false);
        setGauge("ws.connected", "Disconnected");
        setGauge("ws.stream_info_status", "Unavailable");
        setGauge("ws.active_preview_size", "Unavailable");
        setGauge("ws.episode_status", "Unavailable");
        streamInfoRef.current = null;
        episodeStatusRef.current = null;
        dirtyRef.current = true;
        wsRef.current = null;
        scheduleReconnect();
      };

      const onError = () => {
        // The close handler drives reconnect behavior.
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    };

    connect();

    return () => {
      mountedRef.current = false;
      window.clearInterval(flushInterval);
      window.clearInterval(streamInfoInterval);
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      revokeFrameUrls(framesRef.current, revokeObjectUrl);
      framesRef.current.clear();
      robotStatesRef.current.clear();
      streamInfoRef.current = null;
      episodeStatusRef.current = null;
      setGauge("ws.connected", "Disconnected");
    };
  }, [objectUrlFactory, revokeObjectUrl, url, websocketFactory]);

  return { frames, robotStates, streamInfo, episodeStatus, connected, send };
}
