"""Arm channel control loop for the AGX Nero device.

The loop is structured around two protocols (`ArmBackend` and `ArmIpc`) so
the four mode behaviours can be unit-tested with in-memory fakes (no
`pyAgxArm`, no `iceoryx2`). The "real" wiring is in `runtime/device.py`.

Per-tick contract (executes at `config.control_frequency_hz`):

  1. Drain the `control/mode` subscriber; on a transition, run any
     mode-entry book-keeping (e.g. `Disabled` snapshots `q_start`).
  2. Publish the current mode to `info/mode`.
  3. Read `q_meas`, `qd_meas`, `tau_meas`. Skip the tick if `q_meas` is
     unavailable yet (CAN reader still warming up).
  4. Compute `g(q_meas)` via Pinocchio RNEA (clipped to per-joint TAU_MAX).
  5. Compute `(p_des, v_des, kp, kd)` per mode:
        * Disabled: linear ramp `q_start -> 0` over RAMP_DURATION_S, then hold.
        * Identifying / FreeDrive: `0, 0, 0, FREE_DRIVE_KD`.
        * CommandFollowing: from latest joint_position / joint_mit / end_pose
          command (with IK for end_pose); fall back to `q_meas`-tracking if
          no fresh command in the queue.
  6. Send per-joint `move_mit(i+1, p_des[i], v_des[i], kp, kd, ff[i])`.
  7. Publish state topics from `q_meas`, `qd_meas`, `tau_meas`,
     `Pinocchio FK(q_meas)`.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .. import ARM_DOF
from ..config import (
    DEFAULT_FREE_DRIVE_KD,
    DEFAULT_IDENTIFYING_KD,
    DEFAULT_TRACKING_KD,
    DEFAULT_TRACKING_KP,
    ArmChannelConfig,
)
from ..gravity import NeroModel
from ..ipc.types import (
    DEVICE_CHANNEL_MODE_COMMAND_FOLLOWING,
    DEVICE_CHANNEL_MODE_DISABLED,
    DEVICE_CHANNEL_MODE_FREE_DRIVE,
    DEVICE_CHANNEL_MODE_IDENTIFYING,
    JointMitCommand15,
    JointVector15,
    Pose7,
)

# Smooth-ramp constants for the `Disabled` mode entry. The arm is driven
# from its current pose down to q=0 over RAMP_DURATION_S seconds with PD
# tracking + gravity feed-forward, then held at zero indefinitely. Lifted
# directly from `home_on_exit_mit` in
# `external/reference/nero-demo/gravity_compensation.py`.
RAMP_DURATION_S: float = 3.0
RAMP_KP: float = DEFAULT_TRACKING_KP
RAMP_KD: float = DEFAULT_TRACKING_KD

# Default settle time held *after* the ramp completes during the
# `home_on_exit` shutdown phase. With the ramp duration above we wait
# `RAMP_DURATION_S + HOMING_SETTLE_S` seconds before the run loop returns,
# matching the `--exit-settle` default in
# `external/reference/nero-demo/gravity_compensation.py`.
HOMING_SETTLE_S: float = 1.0
HOMING_FEEDBACK_WAIT_S: float = 0.5


# ---------------------------------------------------------------------------
# Protocols (so runtime can be unit-tested without pyAgxArm / iceoryx2)
# ---------------------------------------------------------------------------


class ArmBackend(Protocol):
    """Subset of the pyAgxArm Nero driver API used by the arm runtime."""

    def get_joint_angles_array(self) -> np.ndarray | None: ...

    def get_joint_velocities_array(self) -> np.ndarray | None: ...

    def get_joint_efforts_array(self) -> np.ndarray | None: ...

    def move_mit(
        self,
        joint_index: int,
        p_des: float,
        v_des: float,
        kp: float,
        kd: float,
        t_ff: float,
    ) -> None: ...


class ArmIpc(Protocol):
    """Subset of iceoryx2 traffic used by the arm runtime."""

    def poll_mode_change(self) -> int | None: ...

    def publish_mode(self, mode_value: int) -> None: ...

    def poll_joint_position_command(self) -> JointVector15 | None: ...

    def poll_joint_mit_command(self) -> JointMitCommand15 | None: ...

    def poll_end_pose_command(self) -> Pose7 | None: ...

    def publish_joint_position(self, msg: JointVector15) -> None: ...

    def publish_joint_velocity(self, msg: JointVector15) -> None: ...

    def publish_joint_effort(self, msg: JointVector15) -> None: ...

    def publish_end_effector_pose(self, msg: Pose7) -> None: ...

    def shutdown_requested(self) -> bool: ...


# ---------------------------------------------------------------------------
# Mode mapping
# ---------------------------------------------------------------------------

_MODE_BY_NAME: dict[str, int] = {
    "free-drive": DEVICE_CHANNEL_MODE_FREE_DRIVE,
    "command-following": DEVICE_CHANNEL_MODE_COMMAND_FOLLOWING,
    "identifying": DEVICE_CHANNEL_MODE_IDENTIFYING,
    "disabled": DEVICE_CHANNEL_MODE_DISABLED,
}


def mode_value_for_config(config: ArmChannelConfig) -> int:
    return _MODE_BY_NAME[config.mode]


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _DisabledRamp:
    """State for the `Disabled` mode's smooth ramp + hold transition."""

    q_start: np.ndarray
    started_at: float
    duration_s: float = RAMP_DURATION_S

    def desired(self, now: float) -> tuple[np.ndarray, np.ndarray]:
        """Return (p_des, v_des) at `now` along a linear `q_start -> 0` ramp."""
        elapsed = max(0.0, now - self.started_at)
        if self.duration_s <= 0.0 or elapsed >= self.duration_s:
            return np.zeros_like(self.q_start), np.zeros_like(self.q_start)
        alpha = elapsed / self.duration_s
        p_des = self.q_start * (1.0 - alpha)
        v_des = -self.q_start / self.duration_s
        return p_des, v_des


@dataclass(slots=True)
class ArmTickResult:
    """Per-tick observability output (used by tests)."""

    mode_value: int
    sent_targets: list[tuple[int, float, float, float, float, float]]
    published_states: list[str]


class ArmController:
    """Per-tick control loop for the AGX Nero arm channel.

    Owns the desired mode + the per-mode entry book-keeping. Does NOT own
    the IPC node itself (the device-level orchestrator does); the
    controller talks to whatever object satisfies `ArmIpc`. Likewise, IK is
    pluggable so tests can inject a deterministic IK without pinocchio.
    """

    def __init__(
        self,
        *,
        backend: ArmBackend,
        ipc: ArmIpc,
        model: NeroModel,
        config: ArmChannelConfig,
        ik_solver: Callable[..., tuple[np.ndarray, bool, float]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._backend = backend
        self._ipc = ipc
        self._model = model
        self._config = config
        self._clock = clock
        self._mode_value: int = mode_value_for_config(config)
        self._disabled_ramp: _DisabledRamp | None = None
        self._latest_joint_target: np.ndarray | None = None

        if ik_solver is None:
            from ..ik import solve as default_ik

            self._ik = default_ik
        else:
            self._ik = ik_solver

    # ----- public surface -----

    @property
    def mode_value(self) -> int:
        return self._mode_value

    def step(self, *, accept_mode_changes: bool = True) -> ArmTickResult:
        """Execute one control tick and return what was emitted (for tests).

        When `accept_mode_changes=False`, incoming `control/mode` messages
        are not consulted -- used during the `home_on_exit` shutdown phase
        so a stray late-arriving mode-switch from the controller cannot
        abort the homing ramp.
        """
        sent: list[tuple[int, float, float, float, float, float]] = []
        published: list[str] = []

        if accept_mode_changes:
            new_mode = self._ipc.poll_mode_change()
            if new_mode is not None and new_mode != self._mode_value:
                self._on_mode_change(new_mode)

        self._ipc.publish_mode(self._mode_value)

        q_meas = self._backend.get_joint_angles_array()
        if q_meas is None:
            return ArmTickResult(
                mode_value=self._mode_value,
                sent_targets=sent,
                published_states=published,
            )

        q_meas = np.asarray(q_meas, dtype=float)[:ARM_DOF]
        if q_meas.shape != (ARM_DOF,):
            return ArmTickResult(
                mode_value=self._mode_value,
                sent_targets=sent,
                published_states=published,
            )

        # Defensive: lazily snapshot q_start the first time we hit a
        # disabled-mode tick. Avoids crashing if the controller starts in
        # Disabled before we ever observed q_meas.
        if self._mode_value == DEVICE_CHANNEL_MODE_DISABLED and self._disabled_ramp is None:
            self._disabled_ramp = _DisabledRamp(
                q_start=q_meas.copy(), started_at=self._clock()
            )

        ff = self._model.gravity_torques_clipped(q_meas)

        p_des, v_des, kp, kd = self._desired(q_meas)

        for i in range(ARM_DOF):
            self._backend.move_mit(
                joint_index=i + 1,
                p_des=float(p_des[i]),
                v_des=float(v_des[i]),
                kp=float(kp),
                kd=float(kd),
                t_ff=float(ff[i]),
            )
            sent.append(
                (
                    i + 1,
                    float(p_des[i]),
                    float(v_des[i]),
                    float(kp),
                    float(kd),
                    float(ff[i]),
                )
            )

        published.extend(self._publish_states(q_meas))

        return ArmTickResult(
            mode_value=self._mode_value,
            sent_targets=sent,
            published_states=published,
        )

    def run(
        self,
        stop_check: Callable[[], bool],
        *,
        home_on_exit: bool = True,
        homing_settle_s: float = HOMING_SETTLE_S,
    ) -> None:
        """Block until `stop_check()` is True, ticking at the configured rate.

        When `home_on_exit=True` (the default), the shutdown sequence forces
        the controller into Disabled mode (which snapshots `q_start = q_meas`
        and starts the linear ramp toward zero) and keeps ticking for
        `RAMP_DURATION_S + homing_settle_s` so the ramp can complete and a
        small settle period is held at zero. The motors are NEVER disabled
        -- they keep holding zero with kp=10, kd=0.5 until the orchestrator
        disconnects the CAN socket.
        """
        period = 1.0 / max(self._config.control_frequency_hz, 1.0)
        next_tick = self._clock()
        while not stop_check() and not self._ipc.shutdown_requested():
            self.step()
            next_tick += period
            sleep_s = next_tick - self._clock()
            if sleep_s > 0:
                time.sleep(sleep_s)
            else:
                # We're behind. Realign so we don't spin trying to catch up.
                next_tick = self._clock()

        if home_on_exit:
            self._home_to_zero(settle_s=homing_settle_s)

    def _home_to_zero(self, *, settle_s: float = HOMING_SETTLE_S) -> None:
        """Drive the arm to all-zero positions before returning from `run`.

        Force the controller into Disabled mode (so `_DisabledRamp` snapshots
        `q_start = q_meas` and starts a linear ramp to zero), then keep
        emitting MIT commands for `RAMP_DURATION_S + settle_s` seconds.
        Mode-change polling is disabled during this phase so a stray late
        mode-switch from the controller cannot abort the homing.

        If `q_meas` is unavailable when this method is called (e.g. the CAN
        reader hasn't produced a frame yet), poll briefly before snapshotting
        so the ramp starts from the actual pose rather than zero.
        """
        # Wait briefly for fresh joint feedback so the ramp begins from the
        # arm's actual pose, not the (potentially-stale) zero default.
        deadline = self._clock() + HOMING_FEEDBACK_WAIT_S
        while (
            self._backend.get_joint_angles_array() is None
            and self._clock() < deadline
        ):
            time.sleep(0.01)

        # Force-enter Disabled. _on_mode_change clears any prior state and
        # resnapshots q_start from the latest q_meas (or zero if still None).
        if self._mode_value != DEVICE_CHANNEL_MODE_DISABLED:
            self._on_mode_change(DEVICE_CHANNEL_MODE_DISABLED)
        else:
            # Already in Disabled -- e.g. the operator parked the arm there
            # before quitting. Reset the ramp so we start from the current
            # pose, not whatever q_start was captured on entry.
            self._disabled_ramp = None

        period = 1.0 / max(self._config.control_frequency_hz, 1.0)
        homing_deadline = self._clock() + RAMP_DURATION_S + max(0.0, settle_s)
        next_tick = self._clock()
        while self._clock() < homing_deadline:
            self.step(accept_mode_changes=False)
            next_tick += period
            sleep_s = next_tick - self._clock()
            if sleep_s > 0:
                time.sleep(sleep_s)
            else:
                next_tick = self._clock()

    # ----- internals -----

    def _on_mode_change(self, next_mode: int) -> None:
        # Leaving Disabled clears the ramp snapshot so a future re-entry
        # captures the new q_start.
        if self._mode_value == DEVICE_CHANNEL_MODE_DISABLED:
            self._disabled_ramp = None

        if next_mode == DEVICE_CHANNEL_MODE_DISABLED:
            q_meas = self._backend.get_joint_angles_array()
            q_start = (
                np.asarray(q_meas, dtype=float)[:ARM_DOF]
                if q_meas is not None
                else np.zeros(ARM_DOF)
            )
            self._disabled_ramp = _DisabledRamp(q_start=q_start.copy(), started_at=self._clock())

        # Entering CommandFollowing without a fresh command would otherwise
        # send a stale joint target (or zero) on the first tick; clear so
        # the fallback path ("track q_meas") engages until a real command
        # arrives.
        if next_mode == DEVICE_CHANNEL_MODE_COMMAND_FOLLOWING:
            self._latest_joint_target = None

        self._mode_value = next_mode

    def _desired(self, q_meas: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
        if self._mode_value == DEVICE_CHANNEL_MODE_DISABLED:
            assert self._disabled_ramp is not None
            p_des, v_des = self._disabled_ramp.desired(self._clock())
            return p_des, v_des, RAMP_KP, RAMP_KD

        if self._mode_value == DEVICE_CHANNEL_MODE_FREE_DRIVE:
            # Truly floating arm: no PD, only gravity feed-forward. The
            # operator can move it by hand without fighting MIT damping.
            return (
                np.zeros(ARM_DOF),
                np.zeros(ARM_DOF),
                0.0,
                DEFAULT_FREE_DRIVE_KD,
            )

        if self._mode_value == DEVICE_CHANNEL_MODE_IDENTIFYING:
            # Same control shape as FreeDrive (kp=0, kd=0, ff=g(q)). Only
            # the reported mode differs so the rollio setup wizard can
            # highlight this state independently.
            return (
                np.zeros(ARM_DOF),
                np.zeros(ARM_DOF),
                0.0,
                DEFAULT_IDENTIFYING_KD,
            )

        # CommandFollowing
        kp = DEFAULT_TRACKING_KP
        kd = DEFAULT_TRACKING_KD

        # Try sources in priority order: end_pose (cartesian) > joint_mit > joint_position.
        end_pose = self._ipc.poll_end_pose_command()
        if end_pose is not None:
            target7 = [float(end_pose.values[i]) for i in range(7)]
            q_target, _conv, _err = self._ik(self._model, target7, q0=q_meas)
            self._latest_joint_target = q_target
            return q_target, np.zeros(ARM_DOF), kp, kd

        mit = self._ipc.poll_joint_mit_command()
        if mit is not None:
            n = min(int(mit.len), ARM_DOF)
            p_des = np.array(
                [float(mit.position[i]) for i in range(ARM_DOF)] if n == ARM_DOF
                else (
                    [float(mit.position[i]) for i in range(n)] + list(q_meas[n:])
                ),
                dtype=float,
            )
            v_des = np.array(
                [float(mit.velocity[i]) for i in range(ARM_DOF)] if n == ARM_DOF
                else [float(mit.velocity[i]) for i in range(n)] + [0.0] * (ARM_DOF - n),
                dtype=float,
            )
            # Honour per-message kp/kd if non-zero, else fall back to defaults.
            kp_msg = float(mit.kp[0]) if n > 0 else 0.0
            kd_msg = float(mit.kd[0]) if n > 0 else 0.0
            self._latest_joint_target = p_des
            return (
                p_des,
                v_des,
                kp_msg if kp_msg > 0.0 else kp,
                kd_msg if kd_msg > 0.0 else kd,
            )

        joint_pos = self._ipc.poll_joint_position_command()
        if joint_pos is not None:
            n = min(int(joint_pos.len), ARM_DOF)
            p_des = np.array(
                [float(joint_pos.values[i]) for i in range(n)]
                + list(q_meas[n:]),
                dtype=float,
            )
            self._latest_joint_target = p_des
            return p_des, np.zeros(ARM_DOF), kp, kd

        # No fresh command this tick: reuse the last joint target if we had
        # one, else hold at the current measured pose.
        p_des = (
            self._latest_joint_target
            if self._latest_joint_target is not None
            else q_meas.copy()
        )
        return p_des, np.zeros(ARM_DOF), kp, kd

    def _publish_states(self, q_meas: np.ndarray) -> list[str]:
        published: list[str] = []
        timestamp_ms = _unix_ms()
        publish_states = self._config.publish_states or [
            "joint_position",
            "joint_velocity",
            "joint_effort",
            "end_effector_pose",
        ]

        if "joint_position" in publish_states:
            self._ipc.publish_joint_position(
                JointVector15.from_values(timestamp_ms, list(q_meas))
            )
            published.append("joint_position")

        if "joint_velocity" in publish_states:
            qd = self._backend.get_joint_velocities_array()
            if qd is not None:
                self._ipc.publish_joint_velocity(
                    JointVector15.from_values(
                        timestamp_ms, [float(v) for v in np.asarray(qd)[:ARM_DOF]]
                    )
                )
                published.append("joint_velocity")

        if "joint_effort" in publish_states:
            tau = self._backend.get_joint_efforts_array()
            if tau is not None:
                self._ipc.publish_joint_effort(
                    JointVector15.from_values(
                        timestamp_ms, [float(t) for t in np.asarray(tau)[:ARM_DOF]]
                    )
                )
                published.append("joint_effort")

        if "end_effector_pose" in publish_states:
            pose = self._model.end_effector_pose7(q_meas)
            self._ipc.publish_end_effector_pose(Pose7.from_values(timestamp_ms, pose))
            published.append("end_effector_pose")

        return published


def _unix_ms() -> int:
    return int(time.time() * 1000.0) & 0xFFFFFFFFFFFFFFFF


__all__ = [
    "RAMP_DURATION_S",
    "RAMP_KP",
    "RAMP_KD",
    "HOMING_SETTLE_S",
    "HOMING_FEEDBACK_WAIT_S",
    "ArmBackend",
    "ArmIpc",
    "ArmController",
    "ArmTickResult",
    "mode_value_for_config",
]
