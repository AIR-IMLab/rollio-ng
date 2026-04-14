import type { CameraFrame } from "../lib/websocket";
import type { RobotStateMessage, StreamInfoMessage } from "../lib/protocol";

interface InfoPanelProps {
  frames: Map<string, CameraFrame>;
  robotStates: Map<string, RobotStateMessage>;
  streamInfo?: StreamInfoMessage | null;
  connected: boolean;
  orientation: "vertical" | "horizontal";
}

export function InfoPanel({
  frames,
  robotStates,
  streamInfo = null,
  connected,
  orientation,
}: InfoPanelProps) {
  const cameraNames = streamInfo?.cameras.map((camera) => camera.name) ?? Array.from(frames.keys());
  const robotNames = streamInfo?.robots ?? Array.from(robotStates.keys());
  const hasData =
    cameraNames.length > 0 ||
    robotNames.length > 0 ||
    frames.size > 0 ||
    robotStates.size > 0;

  if (!hasData) {
    return (
      <section className="panel">
        <header className="panel__header">Info</header>
        <div className="panel__empty">No devices connected</div>
      </section>
    );
  }

  if (orientation === "horizontal") {
    const cameraLine = cameraNames
      .map((name) => `${name}: ${cameraResolution(name, frames.get(name), streamInfo)}`)
      .join(" | ");
    const robotLine = robotNames
      .map((name) => `${name}: ${robotStates.get(name)?.num_joints ?? 0} DoF`)
      .join(" | ");

    return (
      <section className="panel">
        <header className="panel__header">Info</header>
        <div className="info-panel info-panel--horizontal">
          <div className="info-panel__line">{cameraLine || "No cameras"}</div>
          <div className="info-panel__line">
            {robotLine || "No robots"} | WS: {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel__header">Info</header>
      <div className="info-panel">
        <div className="info-panel__section">
          <div className="info-panel__heading">Devices</div>
          {cameraNames.map((name) => (
            <div className="info-panel__row" key={name}>
              <span>{name}</span>
              <span>{cameraResolution(name, frames.get(name), streamInfo)}</span>
            </div>
          ))}
          {robotNames.map((name) => (
            <div className="info-panel__row" key={name}>
              <span>{name}</span>
              <span>{robotStates.get(name)?.num_joints ?? 0} DoF</span>
            </div>
          ))}
        </div>
        <div className="info-panel__section">
          <div className="info-panel__row">
            <span>WS</span>
            <span>{connected ? "Connected" : "Disconnected"}</span>
          </div>
          {streamInfo ? (
            <div className="info-panel__row">
              <span>Preview</span>
              <span>
                {streamInfo.active_preview_width}x{streamInfo.active_preview_height}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function cameraResolution(
  name: string,
  frame: CameraFrame | undefined,
  streamInfo: StreamInfoMessage | null,
): string {
  const camera = streamInfo?.cameras.find((entry) => entry.name === name);
  if (camera?.source_width != null && camera.source_height != null) {
    return `${camera.source_width}x${camera.source_height}`;
  }
  if (frame) {
    return `${frame.previewWidth}x${frame.previewHeight}`;
  }
  return "n/a";
}
