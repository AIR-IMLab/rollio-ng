import React from "react";
import { Box, Text } from "ink";
import type { AggregatedRobotChannel, RobotChannelSample } from "../lib/websocket.js";
import type { EndEffectorStatus, RobotStateKind } from "../lib/protocol.js";

export interface RobotStatePanelProps {
  channel: AggregatedRobotChannel;
  panelWidth: number;
}

/**
 * Order in which state-kinds are rendered. The list is intentionally
 * device-agnostic: every channel publishes some subset of these kinds, and
 * the renderer just packs the cells of whatever is present into rows.
 */
const KIND_DISPLAY_ORDER: ReadonlyArray<RobotStateKind> = [
  "joint_position",
  "joint_velocity",
  "joint_effort",
  "end_effector_pose",
  "end_effector_twist",
  "end_effector_wrench",
  "parallel_position",
  "parallel_velocity",
  "parallel_effort",
];

/**
 * Short single-character prefix used in cell labels, paired with the value
 * index. Keeps the label compact so a cell still has room for a bar even on
 * narrow panels. End-effector pose uses semantic axis labels instead.
 */
const KIND_LABEL_PREFIX: Record<RobotStateKind, string> = {
  joint_position: "P",
  joint_velocity: "V",
  joint_effort: "E",
  end_effector_pose: "",
  end_effector_twist: "T",
  end_effector_wrench: "W",
  parallel_position: "P",
  parallel_velocity: "V",
  parallel_effort: "E",
};

const POSE_AXIS_LABELS = ["x", "y", "z", "qx", "qy", "qz", "qw"];

/** User-spec layout constraint: at most 6 cells per row. */
const MAX_CELLS_PER_ROW = 6;
/** Floor on cell width so the bar / label / value still render legibly. The
 *  responsive layout falls back to fewer cells per row when the panel can't
 *  satisfy this minimum. */
const MIN_CELL_WIDTH = 12;

interface PanelCell {
  /** Short label, e.g. "P0", "V3", "x", "qx". */
  label: string;
  value: number;
  min: number;
  max: number;
  hasLimits: boolean;
}

export function buildRobotPanelLines({
  channel,
  panelWidth,
}: RobotStatePanelProps): string[] {
  const dof = inferChannelDof(channel);
  const headerName = `${channel.name}${dof ? ` (${dof} DoF)` : ""}`;
  const headerText = `─ ${headerName} `;
  const headerPad = Math.max(0, panelWidth - headerText.length - 2);
  const topBorder = `┌${headerText}${"─".repeat(headerPad)}┐`;
  const bottomBorder = `└${"─".repeat(panelWidth - 2)}┘`;
  const lines: string[] = [topBorder];

  const eeText = formatEndEffectorStatusText(
    channel.endEffectorStatus,
    channel.endEffectorFeedbackValid,
  );
  if (eeText) {
    lines.push(formatPaddedLine(panelWidth, eeText));
  }

  const innerWidth = Math.max(1, panelWidth - 2);
  const cellsPerRow = computeCellsPerRow(innerWidth);
  const cellWidth = Math.max(MIN_CELL_WIDTH, Math.floor(innerWidth / cellsPerRow));

  // Build kind-keyed cell groups in display order, then pack greedily into
  // rows so kinds whose cells fit can share a row (e.g. parallel_position +
  // parallel_velocity + parallel_effort all sit on one row when each only
  // contributes a single cell).
  const groups = buildCellGroups(channel);
  if (groups.length === 0) {
    lines.push(formatCenteredLine(panelWidth, "Waiting for data..."));
    lines.push(bottomBorder);
    return lines;
  }
  const rows = packGroupsIntoRows(groups, cellsPerRow);

  for (const row of rows) {
    lines.push(formatPaddedLine(panelWidth, renderRow(row, cellWidth)));
  }

  lines.push(bottomBorder);
  return lines;
}

export function RobotStatePanel(props: RobotStatePanelProps) {
  const lines = buildRobotPanelLines(props);
  return (
    <Box flexDirection="column" width={props.panelWidth}>
      {lines.map((line, index) => (
        <Text key={index} dimColor={index === 0 || index === lines.length - 1}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Compute the maximum number of cells per visual row. Capped at the
 * user-requested 6-cell layout, and lowered when the panel is too narrow to
 * keep cells readable. Always returns at least 1 so we don't divide by zero.
 */
function computeCellsPerRow(innerWidth: number): number {
  return Math.max(
    1,
    Math.min(MAX_CELLS_PER_ROW, Math.floor(innerWidth / MIN_CELL_WIDTH)),
  );
}

/** All cells contributed by a single state-kind, in joint order. */
interface CellGroup {
  cells: PanelCell[];
}

function buildCellGroups(channel: AggregatedRobotChannel): CellGroup[] {
  const groups: CellGroup[] = [];
  for (const kind of KIND_DISPLAY_ORDER) {
    const sample = channel.states[kind];
    if (!sample || sample.values.length === 0) continue;
    const cells: PanelCell[] = [];
    for (let i = 0; i < sample.values.length; i++) {
      cells.push(buildCell(kind, i, sample));
    }
    groups.push({ cells });
  }
  return groups;
}

function buildCell(
  kind: RobotStateKind,
  index: number,
  sample: RobotChannelSample,
): PanelCell {
  const min = sample.valueMin[index];
  const max = sample.valueMax[index];
  const hasLimits =
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    (max as number) > (min as number);
  return {
    label: cellLabel(kind, index),
    value: sample.values[index] ?? 0,
    min: hasLimits ? (min as number) : 0,
    max: hasLimits ? (max as number) : 0,
    hasLimits,
  };
}

function cellLabel(kind: RobotStateKind, index: number): string {
  if (kind === "end_effector_pose") {
    return POSE_AXIS_LABELS[index] ?? `${index}`;
  }
  return `${KIND_LABEL_PREFIX[kind]}${index}`;
}

/**
 * Pack one group per state-kind into rows of at most `maxPerRow` cells.
 *
 * Rules (chosen to satisfy the user-spec layout):
 *
 * 1. A group whose cell count fits in the remaining space of the current
 *    row is appended to it (lets pos/vel/eff of a 1-DoF EEF share one row).
 * 2. A group that does not fit triggers a row break before it is rendered.
 * 3. A group whose total cell count exceeds `maxPerRow` (rare: 7-cell
 *    cartesian pose, or arms with more than 6 joints) is split into runs of
 *    `maxPerRow` cells, each emitted as a fresh row of its own.
 */
function packGroupsIntoRows(
  groups: ReadonlyArray<CellGroup>,
  maxPerRow: number,
): PanelCell[][] {
  const rows: PanelCell[][] = [];
  let current: PanelCell[] = [];

  const flush = () => {
    if (current.length > 0) {
      rows.push(current);
      current = [];
    }
  };

  for (const group of groups) {
    const cells = group.cells;
    if (cells.length === 0) continue;
    if (cells.length > maxPerRow) {
      flush();
      for (let i = 0; i < cells.length; i += maxPerRow) {
        rows.push(cells.slice(i, i + maxPerRow));
      }
      continue;
    }
    if (current.length + cells.length > maxPerRow) {
      flush();
    }
    current.push(...cells);
  }
  flush();
  return rows;
}

function renderRow(row: PanelCell[], cellWidth: number): string {
  return row.map((cell) => renderBarCell(cellWidth, cell)).join("");
}

/**
 * Render a single bar cell padded to `cellWidth`. When the driver did not
 * provide value limits for this index, the bar area is replaced with a
 * `???` placeholder so the operator can see at a glance which channel is
 * misconfigured (the spec requires every robot channel to expose limits).
 */
function renderBarCell(cellWidth: number, cell: PanelCell): string {
  const labelPart = `${cell.label} `;
  const valuePart = ` ${formatValue(cell.value)}`;
  const barWidth = Math.max(1, cellWidth - labelPart.length - valuePart.length - 1);
  let barContent: string;
  if (cell.hasLimits) {
    const normalized = normalize(cell.value, cell.min, cell.max);
    const filled = Math.round(normalized * barWidth);
    const empty = Math.max(0, barWidth - filled);
    barContent = "█".repeat(Math.max(0, filled)) + "░".repeat(empty);
  } else {
    // No driver-provided envelope — render a placeholder instead of guessing.
    barContent = "?".repeat(barWidth);
  }
  const cellText = `${labelPart}${barContent}${valuePart}`;
  if (cellText.length >= cellWidth) {
    return cellText.substring(0, cellWidth);
  }
  return cellText + " ".repeat(cellWidth - cellText.length);
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return " n/a ";
  const sign = value >= 0 ? "+" : "";
  const formatted = `${sign}${value.toFixed(2)}`;
  return formatted.padStart(5);
}

function normalize(value: number, min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(1, (value - min) / span));
}

function inferChannelDof(channel: AggregatedRobotChannel): number {
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

function formatEndEffectorStatusText(
  status: EndEffectorStatus | undefined,
  feedbackValid: boolean | undefined,
): string | null {
  if (!status) return null;
  const feedbackLabel =
    feedbackValid === undefined
      ? ""
      : ` | Feedback: ${feedbackValid ? "ok" : "stale"}`;
  return `Status: ${status[0].toUpperCase()}${status.slice(1)}${feedbackLabel}`;
}

function formatPaddedLine(panelWidth: number, content: string): string {
  const inner = content.substring(0, panelWidth - 2);
  const pad = Math.max(0, panelWidth - 2 - inner.length);
  return `│${inner}${" ".repeat(pad)}│`;
}

function formatCenteredLine(panelWidth: number, content: string): string {
  const inner = content.substring(0, panelWidth - 2);
  const pad = Math.max(0, panelWidth - 2 - inner.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `│${" ".repeat(left)}${inner}${" ".repeat(right)}│`;
}
