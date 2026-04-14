import type { EndEffectorStatus } from "../lib/protocol";

export interface RobotStatePanelProps {
  name: string;
  numJoints: number;
  positions: number[];
  endEffectorStatus?: EndEffectorStatus;
  endEffectorFeedbackValid?: boolean;
}

const PI = Math.PI;
const END_EFFECTOR_MIN = 0.0;
const END_EFFECTOR_MAX = 0.07;

export function RobotStatePanel({
  name,
  numJoints,
  positions,
  endEffectorStatus,
  endEffectorFeedbackValid,
}: RobotStatePanelProps) {
  const waitingForData = numJoints === 0 || positions.length === 0;

  return (
    <section className="panel">
      <header className="panel__header">
        {name} ({numJoints} DoF)
      </header>
      <div className="robot-panel">
        {endEffectorStatus ? (
          <div className="robot-panel__status">
            {formatEndEffectorStatusText(endEffectorStatus, endEffectorFeedbackValid)}
          </div>
        ) : null}
        {waitingForData ? (
          <div className="panel__empty">
            {endEffectorStatus
              ? `${formatEndEffectorStatusText(endEffectorStatus, endEffectorFeedbackValid)} | Waiting for feedback`
              : "Waiting for data..."}
          </div>
        ) : (
          <div className="robot-panel__grid">
            {Array.from({ length: numJoints }, (_, index) => {
              const pos = positions[index] ?? 0;
              const normalized = normalizePositionForDisplay(
                pos,
                Boolean(endEffectorStatus),
              );
              return (
                <div className="robot-panel__joint" key={`${name}-${index}`}>
                  <span className="robot-panel__joint-label">J{index}</span>
                  <div className="robot-panel__bar">
                    <div
                      className="robot-panel__bar-fill"
                      style={{ width: `${Math.max(0, Math.min(1, normalized)) * 100}%` }}
                    />
                  </div>
                  <span className="robot-panel__joint-value">
                    {pos >= 0 ? " " : ""}
                    {pos.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function formatEndEffectorStatusText(
  status: EndEffectorStatus,
  feedbackValid?: boolean,
): string {
  const feedbackLabel =
    feedbackValid === undefined ? "" : ` | Feedback: ${feedbackValid ? "ok" : "stale"}`;
  return `Status: ${status[0].toUpperCase()}${status.slice(1)}${feedbackLabel}`;
}

function normalizePositionForDisplay(
  position: number,
  isEndEffector: boolean,
): number {
  if (isEndEffector) {
    const span = END_EFFECTOR_MAX - END_EFFECTOR_MIN;
    if (span <= 0) {
      return 0;
    }
    return Math.max(
      0,
      Math.min(1, (position - END_EFFECTOR_MIN) / span),
    );
  }

  return Math.max(0, Math.min(1, (position + PI) / (2 * PI)));
}
