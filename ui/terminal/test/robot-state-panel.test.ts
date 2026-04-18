import assert from "node:assert/strict";
import test from "node:test";
import { buildRobotPanelLines } from "../src/components/RobotStatePanel.js";
import type { AggregatedRobotChannel } from "../src/lib/websocket.js";

function buildChannel(
  overrides: Partial<AggregatedRobotChannel> & {
    name: string;
    states?: AggregatedRobotChannel["states"];
  },
): AggregatedRobotChannel {
  return {
    states: {},
    lastTimestampMs: 0,
    ...overrides,
  };
}

const ARM_POS_LIMITS = {
  min: [-Math.PI, -Math.PI, -Math.PI, -Math.PI, -Math.PI, -Math.PI],
  max: [Math.PI, Math.PI, Math.PI, Math.PI, Math.PI, Math.PI],
};

test("buildRobotPanelLines includes end-effector status for standalone EEFs", () => {
  const lines = buildRobotPanelLines({
    panelWidth: 80,
    channel: buildChannel({
      name: "eef_g2",
      states: {
        parallel_position: {
          values: [0.042],
          valueMin: [0],
          valueMax: [0.07],
          numJoints: 1,
          timestampMs: 100,
        },
      },
      endEffectorStatus: "enabled",
      endEffectorFeedbackValid: true,
    }),
  });

  const text = lines.join("\n");
  assert.match(text, /Status: Enabled \| Feedback: ok/);
  // Single-cell parallel position renders the "P0" label and value.
  assert.match(text, /P0/);
  assert.match(text, /\+0\.04/);
});

test("buildRobotPanelLines falls back to waiting message for empty channels", () => {
  const lines = buildRobotPanelLines({
    panelWidth: 80,
    channel: buildChannel({ name: "leader_arm" }),
  });

  assert.match(lines.join("\n"), /Waiting for data/);
});

test("EEF channel renders pos/vel/eff on a single half-row", () => {
  const channel = buildChannel({
    name: "airbot_g2",
    states: {
      parallel_position: {
        values: [0.04],
        valueMin: [0],
        valueMax: [0.07],
        numJoints: 1,
        timestampMs: 100,
      },
      parallel_velocity: {
        values: [0.1],
        valueMin: [-0.5],
        valueMax: [0.5],
        numJoints: 1,
        timestampMs: 100,
      },
      parallel_effort: {
        values: [2.0],
        valueMin: [-10],
        valueMax: [10],
        numJoints: 1,
        timestampMs: 100,
      },
    },
  });

  // 80-column panel easily fits 6 cells; 3 cells take half the width.
  const lines = buildRobotPanelLines({ panelWidth: 80, channel });
  // Body lines exclude the top + bottom border.
  const bodyLines = lines.slice(1, -1);
  // Single value-row with all three kinds collapsed into one half-row,
  // sharing labels P0 / V0 / E0 in left-to-right order.
  assert.equal(bodyLines.length, 1, `expected one row, got ${JSON.stringify(bodyLines)}`);
  assert.ok(/P0/.test(bodyLines[0]), `missing P0 in ${bodyLines[0]}`);
  assert.ok(/V0/.test(bodyLines[0]), `missing V0 in ${bodyLines[0]}`);
  assert.ok(/E0/.test(bodyLines[0]), `missing E0 in ${bodyLines[0]}`);
  // Each cell is 80/6 = 13 chars wide; 3 used + 3 empty = the right half is
  // padding-only (no bar / value text). Confirm the row ends with whitespace
  // before the right border.
  const inner = bodyLines[0].slice(1, -1); // strip │ borders
  assert.ok(
    /\s{15,}$/.test(inner),
    `right half should be padding-only, got tail: ${JSON.stringify(inner.slice(-20))}`,
  );
});

test("six-DoF arm with pos+vel+eff renders three rows of six cells", () => {
  const channel = buildChannel({
    name: "airbot_play_arm",
    states: {
      joint_position: {
        values: [0.1, 0.2, -0.3, 0.4, -0.5, 0.6],
        valueMin: ARM_POS_LIMITS.min,
        valueMax: ARM_POS_LIMITS.max,
        numJoints: 6,
        timestampMs: 100,
      },
      joint_velocity: {
        values: [0.0, 0.1, 0.2, 0.0, 0.1, 0.2],
        valueMin: ARM_POS_LIMITS.min,
        valueMax: ARM_POS_LIMITS.max,
        numJoints: 6,
        timestampMs: 100,
      },
      joint_effort: {
        values: [0.0, 1.0, -1.0, 2.0, -2.0, 0.0],
        valueMin: [-50, -50, -50, -50, -50, -50],
        valueMax: [50, 50, 50, 50, 50, 50],
        numJoints: 6,
        timestampMs: 100,
      },
    },
  });

  const lines = buildRobotPanelLines({ panelWidth: 120, channel });
  const bodyLines = lines.slice(1, -1);
  assert.equal(bodyLines.length, 3, `expected three rows, got ${bodyLines.length}`);
  assert.ok(/P0/.test(bodyLines[0]) && /P5/.test(bodyLines[0]), "row 1 should hold P0..P5");
  assert.ok(/V0/.test(bodyLines[1]) && /V5/.test(bodyLines[1]), "row 2 should hold V0..V5");
  assert.ok(/E0/.test(bodyLines[2]) && /E5/.test(bodyLines[2]), "row 3 should hold E0..E5");
});

test("seven-element pose wraps into row of six + row of one", () => {
  const channel = buildChannel({
    name: "airbot_play_arm",
    states: {
      end_effector_pose: {
        values: [0.3, 0.0, 0.5, 0, 0, 0, 1],
        valueMin: [-0.6, -0.6, -0.1, -1, -1, -1, -1],
        valueMax: [0.6, 0.6, 0.7, 1, 1, 1, 1],
        numJoints: 7,
        timestampMs: 100,
      },
    },
  });

  const lines = buildRobotPanelLines({ panelWidth: 120, channel });
  const bodyLines = lines.slice(1, -1);
  assert.equal(bodyLines.length, 2, `expected pose to wrap onto two rows`);
  assert.ok(/qw/.test(bodyLines[1]), "row 2 should contain the wrapped quaternion w");
});

test("missing limits render as `?` placeholder bars instead of guessed defaults", () => {
  const channel = buildChannel({
    name: "leader_arm",
    states: {
      joint_position: {
        values: [0.5],
        // Driver did not provide limits — render an obvious placeholder so
        // the operator notices the misconfiguration immediately.
        valueMin: [],
        valueMax: [],
        numJoints: 1,
        timestampMs: 100,
      },
    },
  });

  const lines = buildRobotPanelLines({ panelWidth: 80, channel });
  const text = lines.join("\n");
  // Numeric value still rendered so the operator sees something.
  assert.match(text, /\+0\.50/);
  // No filled bar should appear — only `?` placeholder characters.
  assert.ok(/\?{3,}/.test(text), `expected ??? placeholder bar, got: ${text}`);
  assert.ok(!/█/.test(text), `unexpected filled bar despite missing limits: ${text}`);
});

test("narrow panels honour the 6-per-row constraint by reducing cells per row", () => {
  const channel = buildChannel({
    name: "leader_arm",
    states: {
      joint_position: {
        values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        valueMin: ARM_POS_LIMITS.min,
        valueMax: ARM_POS_LIMITS.max,
        numJoints: 6,
        timestampMs: 100,
      },
    },
  });

  // 50-column panel -> inner width 48 -> floor(48/12) = 4 cells/row.
  const lines = buildRobotPanelLines({ panelWidth: 50, channel });
  const bodyLines = lines.slice(1, -1);
  // 6 cells in groups of 4 -> 2 rows: [P0..P3][P4,P5].
  assert.ok(
    bodyLines.length >= 2,
    `expected wrap onto multiple rows, got ${bodyLines.length}`,
  );
  // The wrapped row should still mention P5.
  assert.ok(
    bodyLines.some((line) => /P5/.test(line)),
    `expected to find P5 in wrapped rows: ${JSON.stringify(bodyLines)}`,
  );
});

test("bar fill is proportional to the driver-supplied envelope", () => {
  const closedChannel = buildChannel({
    name: "eef_g2",
    states: {
      parallel_position: {
        values: [0.0],
        valueMin: [0],
        valueMax: [0.07],
        numJoints: 1,
        timestampMs: 100,
      },
    },
  });
  const openChannel = buildChannel({
    name: "eef_g2",
    states: {
      parallel_position: {
        values: [0.07],
        valueMin: [0],
        valueMax: [0.07],
        numJoints: 1,
        timestampMs: 100,
      },
    },
  });

  const closed = buildRobotPanelLines({ panelWidth: 80, channel: closedChannel }).join("\n");
  const open = buildRobotPanelLines({ panelWidth: 80, channel: openChannel }).join("\n");

  assert.match(closed, /\+0\.00/);
  assert.match(open, /\+0\.07/);
  assert.ok(
    (open.match(/█/g) ?? []).length > (closed.match(/█/g) ?? []).length,
    "open end effector should render a fuller bar than the closed position",
  );
});
