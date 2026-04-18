import React from "react";
import { Box, Text } from "ink";
import type { AggregatedRobotChannel, CameraFrame } from "../lib/websocket.js";
import type { StreamInfoMessage } from "../lib/protocol.js";

interface InfoPanelProps {
  frames: Map<string, CameraFrame>;
  robotChannels: Map<string, AggregatedRobotChannel>;
  streamInfo?: StreamInfoMessage | null;
  connected: boolean;
  orientation: "vertical" | "horizontal";
  panelWidth: number;
}

export function InfoPanel({
  frames,
  robotChannels,
  streamInfo = null,
  connected,
  orientation,
  panelWidth,
}: InfoPanelProps) {
  const headerText = "─ Info ";
  const headerPad = Math.max(0, panelWidth - headerText.length - 2);
  const topBorder = `┌${headerText}${"─".repeat(headerPad)}┐`;
  const bottomBorder = `└${"─".repeat(panelWidth - 2)}┘`;
  const innerW = panelWidth - 2;

  const hasData = frames.size > 0 || robotChannels.size > 0;

  if (!hasData) {
    const msg = "No devices connected";
    const pad = Math.max(0, innerW - msg.length);
    const left = Math.floor(pad / 2);
    const right = pad - left;

    return (
      <Box flexDirection="column" width={panelWidth}>
        <Text dimColor>{topBorder}</Text>
        <Text dimColor>{`│${" ".repeat(left)}${msg}${" ".repeat(right)}│`}</Text>
        <Text dimColor>{bottomBorder}</Text>
      </Box>
    );
  }

  const lines: string[] = [];

  if (orientation === "vertical") {
    lines.push(padLine(" Devices", innerW));

    for (const [name, frame] of frames) {
      lines.push(
        padLine(`  ${name}  ${cameraResolution(name, frame, streamInfo)}`, innerW),
      );
    }

    for (const [name, channel] of robotChannels) {
      lines.push(padLine(`  ${name}  ${dofForChannel(channel)} DoF`, innerW));
    }

    lines.push(padLine("", innerW));
    lines.push(
      padLine(` WS: ${connected ? "Connected" : "Disconnected"}`, innerW),
    );
  } else {
    const camParts: string[] = [];
    for (const [name, frame] of frames) {
      camParts.push(`${name}: ${cameraResolution(name, frame, streamInfo)}`);
    }

    const robotParts: string[] = [];
    for (const [name, channel] of robotChannels) {
      robotParts.push(`${name}: ${dofForChannel(channel)} DoF`);
    }

    const line1 = ` ${camParts.join(" | ")}`;
    const line2 = ` ${robotParts.join(" | ")}`;

    lines.push(padLine(line1, innerW));
    lines.push(padLine(line2, innerW));
  }

  return (
    <Box flexDirection="column" width={panelWidth}>
      <Text dimColor>{topBorder}</Text>
      {lines.map((line, i) => (
        <Text key={i}>{`│${line}│`}</Text>
      ))}
      <Text dimColor>{bottomBorder}</Text>
    </Box>
  );
}

function dofForChannel(channel: AggregatedRobotChannel): number {
  const sample =
    channel.states.joint_position ??
    channel.states.parallel_position ??
    channel.states.end_effector_pose;
  if (sample) {
    return sample.numJoints || sample.values.length;
  }
  for (const value of Object.values(channel.states)) {
    if (value) {
      return value.numJoints || value.values.length;
    }
  }
  return 0;
}

function padLine(text: string, width: number): string {
  const trimmed = text.substring(0, width);
  return trimmed + " ".repeat(Math.max(0, width - trimmed.length));
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
