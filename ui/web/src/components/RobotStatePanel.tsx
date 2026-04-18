import type { EndEffectorStatus, RobotStateKind } from "../lib/protocol";
import type {
  AggregatedRobotChannel,
  RobotChannelSample,
} from "../lib/websocket";

export interface RobotStatePanelProps {
  channel: AggregatedRobotChannel;
}

/**
 * Order in which state-kinds are rendered. Mirrors the terminal UI so the
 * web view shows the same panel layout per channel.
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

interface PanelCell {
  label: string;
  value: number;
  min: number;
  max: number;
  hasLimits: boolean;
}

export function RobotStatePanel({ channel }: RobotStatePanelProps) {
  const dof = inferChannelDof(channel);
  const groups = buildCellGroups(channel);
  const eeText = formatEndEffectorStatusText(
    channel.endEffectorStatus,
    channel.endEffectorFeedbackValid,
  );

  return (
    <section className="panel">
      <header className="panel__header">
        {channel.name}
        {dof ? ` (${dof} DoF)` : ""}
      </header>
      <div className="robot-panel">
        {eeText ? <div className="robot-panel__status">{eeText}</div> : null}
        {groups.length === 0 ? (
          <div className="panel__empty">
            {eeText ? "Waiting for feedback" : "Waiting for data..."}
          </div>
        ) : (
          <div className="robot-panel__grid">
            {groups.flatMap((group) =>
              group.cells.map((cell, index) => (
                <div
                  className="robot-panel__joint"
                  key={`${channel.name}-${group.kind}-${index}`}
                >
                  <span className="robot-panel__joint-label">{cell.label}</span>
                  <div className="robot-panel__bar">
                    {cell.hasLimits ? (
                      <div
                        className="robot-panel__bar-fill"
                        style={{
                          width: `${normalize(cell.value, cell.min, cell.max) * 100}%`,
                        }}
                      />
                    ) : (
                      <div className="robot-panel__bar-placeholder">?</div>
                    )}
                  </div>
                  <span className="robot-panel__joint-value">
                    {formatValue(cell.value)}
                  </span>
                </div>
              )),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface CellGroup {
  kind: RobotStateKind;
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
    groups.push({ kind, cells });
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

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? " " : "";
  return `${sign}${value.toFixed(2)}`;
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
    feedbackValid === undefined ? "" : ` | Feedback: ${feedbackValid ? "ok" : "stale"}`;
  return `Status: ${status[0].toUpperCase()}${status.slice(1)}${feedbackLabel}`;
}
