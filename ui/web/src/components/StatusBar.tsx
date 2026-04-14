import type { EpisodeKeyBindings } from "../lib/runtime-config";

type HealthStatus = "normal" | "degraded" | "failure";
type EpisodeState = "idle" | "recording" | "pending";

interface StatusBarProps {
  mode: string;
  state: EpisodeState;
  episodeCount: number;
  elapsedMs: number;
  episodeKeyBindings: EpisodeKeyBindings;
  connected: boolean;
  health: HealthStatus;
  debugEnabled?: boolean;
}

const HEALTH_LABELS: Record<HealthStatus, string> = {
  normal: "[Normal]",
  degraded: "[Degraded]",
  failure: "[Failure]",
};

export function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatEpisodeState(state: EpisodeState): string {
  switch (state) {
    case "idle":
      return "Idle";
    case "recording":
      return "Recording";
    case "pending":
      return "Pending";
  }
}

export function buildStatusBarLeft(props: {
  mode: string;
  state: EpisodeState;
  episodeCount: number;
  elapsedMs: number;
  episodeKeyBindings: EpisodeKeyBindings;
  connected: boolean;
  debugEnabled?: boolean;
}): string {
  const connStatus = props.connected ? "Connected" : "Disconnected";
  const debugStatus = props.debugEnabled ? "On" : "Off";
  const stateLabel =
    props.state === "recording"
      ? `${formatEpisodeState(props.state)} ${formatElapsedMs(props.elapsedMs)}`
      : formatEpisodeState(props.state);
  const controlHint =
    props.state === "idle"
      ? `${props.episodeKeyBindings.startKey}:Start`
      : props.state === "recording"
        ? `${props.episodeKeyBindings.stopKey}:Stop`
        : `${props.episodeKeyBindings.keepKey}:Keep ${props.episodeKeyBindings.discardKey}:Discard`;

  return (
    ` ${props.mode} | ${stateLabel} | Ep: ${props.episodeCount} | WS: ${connStatus}` +
    ` | ${controlHint} | d:Debug ${debugStatus}`
  );
}

export function StatusBar({
  mode,
  state,
  episodeCount,
  elapsedMs,
  episodeKeyBindings,
  connected,
  health,
  debugEnabled = false,
}: StatusBarProps) {
  return (
    <footer className="chrome-bar chrome-bar--status">
      <span className="chrome-bar__left">
        {buildStatusBarLeft({
          mode,
          state,
          episodeCount,
          elapsedMs,
          episodeKeyBindings,
          connected,
          debugEnabled,
        })}
      </span>
      <span className={`chrome-bar__right chrome-bar__right--${health}`}>
        {" "}
        {HEALTH_LABELS[health]}{" "}
      </span>
    </footer>
  );
}
