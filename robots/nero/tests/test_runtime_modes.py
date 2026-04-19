"""End-to-end mode-transition tests for the arm + gripper runtime loops."""

from __future__ import annotations

import numpy as np
import pytest

pin = pytest.importorskip("pinocchio")  # NeroModel needs pinocchio

from rollio_device_nero import ARM_DOF  # noqa: E402
from rollio_device_nero.config import (  # noqa: E402
    ArmChannelConfig,
    GripperChannelConfig,
)
from rollio_device_nero.gravity import NeroModel  # noqa: E402
from rollio_device_nero.ipc.types import (  # noqa: E402
    DEVICE_CHANNEL_MODE_COMMAND_FOLLOWING,
    DEVICE_CHANNEL_MODE_DISABLED,
    DEVICE_CHANNEL_MODE_FREE_DRIVE,
    DEVICE_CHANNEL_MODE_IDENTIFYING,
    JointMitCommand15,
    JointVector15,
    Pose7,
    ParallelMitCommand2,
    ParallelVector2,
)
from rollio_device_nero.config import (  # noqa: E402
    DEFAULT_FREE_DRIVE_KD,
    DEFAULT_IDENTIFYING_KD,
    DEFAULT_TRACKING_KD,
    DEFAULT_TRACKING_KP,
)
from rollio_device_nero.runtime.arm import (  # noqa: E402
    HOMING_SETTLE_S,
    RAMP_DURATION_S,
    RAMP_KD,
    RAMP_KP,
    ArmController,
)
from rollio_device_nero.runtime.gripper import (  # noqa: E402
    IDENTIFY_PERIOD_S,
    MAX_WIDTH_M,
    GripperController,
    identify_target,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeArmBackend:
    def __init__(self, q: np.ndarray) -> None:
        self.q = q.copy()
        self.qd = np.zeros(ARM_DOF)
        self.tau = np.zeros(ARM_DOF)
        self.move_mit_calls: list[tuple[int, float, float, float, float, float]] = []

    def get_joint_angles_array(self) -> np.ndarray | None:
        return self.q.copy()

    def get_joint_velocities_array(self) -> np.ndarray | None:
        return self.qd.copy()

    def get_joint_efforts_array(self) -> np.ndarray | None:
        return self.tau.copy()

    def move_mit(self, joint_index, p_des, v_des, kp, kd, t_ff):  # noqa: D401
        self.move_mit_calls.append((joint_index, p_des, v_des, kp, kd, t_ff))


class FakeArmIpc:
    def __init__(self) -> None:
        self.next_mode: int | None = None
        self.next_joint_position: JointVector15 | None = None
        self.next_joint_mit: JointMitCommand15 | None = None
        self.next_end_pose: Pose7 | None = None
        self.published_modes: list[int] = []
        self.published_joint_position: list[JointVector15] = []
        self.published_joint_velocity: list[JointVector15] = []
        self.published_joint_effort: list[JointVector15] = []
        self.published_end_pose: list[Pose7] = []
        self._shutdown = False

    def poll_mode_change(self):
        m, self.next_mode = self.next_mode, None
        return m

    def publish_mode(self, value):
        self.published_modes.append(value)

    def poll_joint_position_command(self):
        cmd, self.next_joint_position = self.next_joint_position, None
        return cmd

    def poll_joint_mit_command(self):
        cmd, self.next_joint_mit = self.next_joint_mit, None
        return cmd

    def poll_end_pose_command(self):
        cmd, self.next_end_pose = self.next_end_pose, None
        return cmd

    def publish_joint_position(self, msg):
        self.published_joint_position.append(msg)

    def publish_joint_velocity(self, msg):
        self.published_joint_velocity.append(msg)

    def publish_joint_effort(self, msg):
        self.published_joint_effort.append(msg)

    def publish_end_effector_pose(self, msg):
        self.published_end_pose.append(msg)

    def shutdown_requested(self):
        return self._shutdown


class FakeGripperBackend:
    def __init__(self) -> None:
        self.position = 0.02
        self.velocity = 0.0
        self.effort = 0.5
        self.move_calls: list[tuple[float, float]] = []

    def get_gripper_position_m(self):
        return self.position

    def get_gripper_velocity_m_per_s(self):
        return self.velocity

    def get_gripper_effort_n(self):
        return self.effort

    def move_gripper_m(self, value, force):
        self.move_calls.append((value, force))
        self.position = value


class FakeGripperIpc:
    def __init__(self) -> None:
        self.next_mode: int | None = None
        self.next_pos: ParallelVector2 | None = None
        self.next_mit: ParallelMitCommand2 | None = None
        self.published_modes: list[int] = []
        self.published_position: list[ParallelVector2] = []
        self.published_velocity: list[ParallelVector2] = []
        self.published_effort: list[ParallelVector2] = []
        self._shutdown = False

    def poll_mode_change(self):
        m, self.next_mode = self.next_mode, None
        return m

    def publish_mode(self, value):
        self.published_modes.append(value)

    def poll_parallel_position_command(self):
        cmd, self.next_pos = self.next_pos, None
        return cmd

    def poll_parallel_mit_command(self):
        cmd, self.next_mit = self.next_mit, None
        return cmd

    def publish_parallel_position(self, msg):
        self.published_position.append(msg)

    def publish_parallel_velocity(self, msg):
        self.published_velocity.append(msg)

    def publish_parallel_effort(self, msg):
        self.published_effort.append(msg)

    def shutdown_requested(self):
        return self._shutdown


# Reusable model: build once per session.
@pytest.fixture(scope="module")
def nero_model() -> NeroModel:
    return NeroModel(with_gripper=False)


# ---------------------------------------------------------------------------
# Arm tests
# ---------------------------------------------------------------------------


def _arm_controller(model: NeroModel, mode: str, q0: np.ndarray, **kwargs) -> tuple[ArmController, FakeArmBackend, FakeArmIpc]:
    backend = FakeArmBackend(q0)
    ipc = FakeArmIpc()
    cfg = ArmChannelConfig(mode=mode)
    times = iter(kwargs.get("clock_sequence", []))

    def clock() -> float:
        try:
            return next(times)
        except StopIteration:
            return 0.0

    if "clock_sequence" in kwargs:
        ctrl = ArmController(backend=backend, ipc=ipc, model=model, config=cfg, clock=clock)
    else:
        ctrl = ArmController(backend=backend, ipc=ipc, model=model, config=cfg)
    return ctrl, backend, ipc


def test_arm_free_drive_emits_gravity_only_no_damping(nero_model: NeroModel) -> None:
    """FreeDrive must use kp=0, kd=0 so the arm is truly floating."""
    ctrl, backend, ipc = _arm_controller(nero_model, "free-drive", np.zeros(7))
    ctrl.step()
    assert len(backend.move_mit_calls) == ARM_DOF
    assert DEFAULT_FREE_DRIVE_KD == 0.0
    for joint_index, p_des, v_des, kp, kd, t_ff in backend.move_mit_calls:
        assert 1 <= joint_index <= ARM_DOF
        assert p_des == 0.0
        assert v_des == 0.0
        assert kp == 0.0
        assert kd == 0.0
        # gravity feed-forward is bounded by TAU_MAX.
        assert -24.0 <= t_ff <= 24.0
    assert ipc.published_modes[-1] == DEVICE_CHANNEL_MODE_FREE_DRIVE


def test_arm_identifying_emits_gravity_only_no_damping(nero_model: NeroModel) -> None:
    """Identifying must use kp=0, kd=0 (same shape as FreeDrive)."""
    ctrl, backend, ipc = _arm_controller(nero_model, "identifying", np.zeros(7))
    ctrl.step()
    assert len(backend.move_mit_calls) == ARM_DOF
    assert DEFAULT_IDENTIFYING_KD == 0.0
    for joint_index, p_des, v_des, kp, kd, _t_ff in backend.move_mit_calls:
        assert 1 <= joint_index <= ARM_DOF
        assert p_des == 0.0
        assert v_des == 0.0
        assert kp == 0.0
        assert kd == 0.0
    assert ipc.published_modes[-1] == DEVICE_CHANNEL_MODE_IDENTIFYING


def test_arm_identifying_uses_same_shape_as_free_drive(nero_model: NeroModel) -> None:
    """Identifying and FreeDrive emit identical move_mit batches; the
    distinction is only in the reported mode value."""
    ctrl_id, backend_id, ipc_id = _arm_controller(nero_model, "identifying", np.zeros(7))
    ctrl_id.step()
    ctrl_fd, backend_fd, ipc_fd = _arm_controller(nero_model, "free-drive", np.zeros(7))
    ctrl_fd.step()
    assert backend_id.move_mit_calls == backend_fd.move_mit_calls
    assert DEFAULT_FREE_DRIVE_KD == DEFAULT_IDENTIFYING_KD == 0.0
    assert ipc_id.published_modes[-1] == DEVICE_CHANNEL_MODE_IDENTIFYING
    assert ipc_fd.published_modes[-1] == DEVICE_CHANNEL_MODE_FREE_DRIVE


def test_arm_disabled_ramps_then_holds_at_zero(nero_model: NeroModel) -> None:
    q0 = np.array([0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0])
    # Sequence of monotonic-clock readings consumed in step() order:
    #   (1) initial DisabledRamp construction
    #   (2..) per-step _desired() reads
    clock_sequence = [
        0.0,  # ramp.started_at
        0.0,  # tick 1, t = 0
        RAMP_DURATION_S * 0.5,  # tick 2, halfway through ramp
        RAMP_DURATION_S * 1.5,  # tick 3, well after ramp ends -> hold at 0
    ]
    ctrl, backend, _ipc = _arm_controller(
        nero_model, "disabled", q0, clock_sequence=clock_sequence
    )
    # tick 1: at t=0 we should command exactly q_start
    ctrl.step()
    p_des_t1 = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(p_des_t1, q0)
    # tick 2: midway through ramp -> ~0.5 * q_start
    ctrl.step()
    p_des_t2 = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(p_des_t2, q0 * 0.5, atol=1e-6)
    # tick 3: past end of ramp -> hold at exactly zero
    ctrl.step()
    p_des_t3 = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(p_des_t3, np.zeros(7))
    # Gains throughout should be the tracking pair (kp=10, kd=0.5).
    for tick in backend.move_mit_calls:
        assert tick[3] == RAMP_KP
        assert tick[4] == RAMP_KD


def test_arm_command_following_with_joint_position(nero_model: NeroModel) -> None:
    ctrl, backend, ipc = _arm_controller(nero_model, "command-following", np.zeros(7))

    target = JointVector15.from_values(timestamp_ms=0, values=[0.1] * ARM_DOF)
    ipc.next_joint_position = target

    ctrl.step()

    p_des = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    kps = [c[3] for c in backend.move_mit_calls[-ARM_DOF:]]
    kds = [c[4] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(p_des, [0.1] * ARM_DOF)
    assert all(k == DEFAULT_TRACKING_KP for k in kps)
    assert all(k == DEFAULT_TRACKING_KD for k in kds)


def test_arm_command_following_holds_last_target_until_new_command(
    nero_model: NeroModel,
) -> None:
    ctrl, backend, ipc = _arm_controller(nero_model, "command-following", np.zeros(7))

    ipc.next_joint_position = JointVector15.from_values(0, [0.2] * ARM_DOF)
    ctrl.step()
    sent_first = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(sent_first, [0.2] * ARM_DOF)

    # No new command -> latest target is reused.
    ctrl.step()
    sent_second = [c[1] for c in backend.move_mit_calls[-ARM_DOF:]]
    assert np.allclose(sent_second, [0.2] * ARM_DOF)


def test_arm_command_following_via_end_pose_uses_ik(nero_model: NeroModel) -> None:
    ctrl, backend, ipc = _arm_controller(nero_model, "command-following", np.zeros(7))
    pose0 = nero_model.end_effector_pose7(np.zeros(7))
    target = list(pose0)
    target[0] += 0.05
    ipc.next_end_pose = Pose7.from_values(0, target)

    ctrl.step()

    # IK should have moved q1 (base rotation) and q4 (elbow) primarily.
    p_des = np.asarray([c[1] for c in backend.move_mit_calls[-ARM_DOF:]])
    assert not np.allclose(p_des, np.zeros(7), atol=1e-3)


def test_arm_publishes_state_topics_each_tick(nero_model: NeroModel) -> None:
    ctrl, _backend, ipc = _arm_controller(nero_model, "free-drive", np.zeros(7))
    ctrl.step()
    assert len(ipc.published_joint_position) == 1
    assert len(ipc.published_joint_velocity) == 1
    assert len(ipc.published_joint_effort) == 1
    assert len(ipc.published_end_pose) == 1


def test_arm_run_homes_to_zero_on_shutdown(nero_model: NeroModel) -> None:
    """`run()` with default `home_on_exit=True` must drive the arm to q=0
    via the Disabled-mode ramp before returning."""
    q_start = np.array([0.4, -0.3, 0.2, 0.1, -0.1, 0.05, 0.0])
    backend = FakeArmBackend(q_start)
    ipc = FakeArmIpc()
    cfg = ArmChannelConfig(mode="free-drive", control_frequency_hz=1000.0)
    # A virtual clock so the homing ramp completes deterministically inside
    # one test invocation (without sleeping for ~4 s of real time).
    virtual_now = [0.0]

    def clock() -> float:
        return virtual_now[0]

    # Speed: each step bumps the virtual clock by `dt`. We also override
    # `time.sleep` (via monkeypatching the controller's run loop) -- but
    # since `run` calls the global `time.sleep` not a parameter, we instead
    # rely on the fact that the period is 1ms so real sleeps are tiny.
    ctrl = ArmController(backend=backend, ipc=ipc, model=nero_model, config=cfg, clock=clock)

    # `stop_check` becomes True after one normal-mode tick, then we let
    # `_home_to_zero` advance the virtual clock past the ramp+settle window.
    tick_count = [0]

    def stop_check() -> bool:
        if tick_count[0] >= 1:
            return True
        tick_count[0] += 1
        virtual_now[0] += 0.001
        return False

    # Patch the inner `time.sleep` call inside arm.run / _home_to_zero so the
    # homing loop advances the virtual clock instead of really sleeping.
    import rollio_device_nero.runtime.arm as arm_mod
    real_sleep = arm_mod.time.sleep

    def fake_sleep(seconds: float) -> None:
        # Advance the virtual clock by exactly the requested duration so
        # the homing loop terminates at `RAMP_DURATION_S + HOMING_SETTLE_S`.
        virtual_now[0] += max(0.0, seconds)

    arm_mod.time.sleep = fake_sleep
    try:
        ctrl.run(stop_check, homing_settle_s=HOMING_SETTLE_S)
    finally:
        arm_mod.time.sleep = real_sleep

    # 1) Controller ended in Disabled.
    assert ctrl.mode_value == DEVICE_CHANNEL_MODE_DISABLED
    # 2) The very last `move_mit` batch should have commanded p_des=0 with
    #    the tracking gains (kp=10, kd=0.5) -- the Disabled-mode hold.
    final_calls = backend.move_mit_calls[-ARM_DOF:]
    final_p_des = np.asarray([c[1] for c in final_calls])
    assert np.allclose(final_p_des, np.zeros(ARM_DOF))
    for _idx, _p, v_des, kp, kd, _ff in final_calls:
        assert v_des == 0.0
        assert kp == RAMP_KP
        assert kd == RAMP_KD
    # 3) The homing should have lasted at least RAMP_DURATION_S virtual seconds.
    assert virtual_now[0] >= RAMP_DURATION_S


def test_arm_run_skips_homing_when_disabled(nero_model: NeroModel) -> None:
    """`home_on_exit=False` must return immediately after stop is set
    (no homing ramp, no extra ticks beyond the one in-progress)."""
    backend = FakeArmBackend(np.array([0.4, -0.3, 0.2, 0.1, -0.1, 0.05, 0.0]))
    ipc = FakeArmIpc()
    cfg = ArmChannelConfig(mode="free-drive", control_frequency_hz=1000.0)
    ctrl = ArmController(backend=backend, ipc=ipc, model=nero_model, config=cfg)

    tick_count = [0]

    def stop_check() -> bool:
        if tick_count[0] >= 1:
            return True
        tick_count[0] += 1
        return False

    ctrl.run(stop_check, home_on_exit=False)
    # FreeDrive sends ARM_DOF move_mit calls per tick, exactly one tick
    # happened, no homing ticks afterwards.
    assert len(backend.move_mit_calls) == ARM_DOF
    assert ctrl.mode_value == DEVICE_CHANNEL_MODE_FREE_DRIVE


def test_arm_homing_ignores_late_mode_changes(nero_model: NeroModel) -> None:
    """A `control/mode` arriving during homing must not abort the ramp."""
    q_start = np.array([0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    backend = FakeArmBackend(q_start)
    ipc = FakeArmIpc()
    cfg = ArmChannelConfig(mode="free-drive", control_frequency_hz=1000.0)
    virtual_now = [0.0]

    def clock() -> float:
        return virtual_now[0]

    ctrl = ArmController(backend=backend, ipc=ipc, model=nero_model, config=cfg, clock=clock)

    tick_count = [0]

    def stop_check() -> bool:
        if tick_count[0] >= 1:
            return True
        tick_count[0] += 1
        virtual_now[0] += 0.001
        return False

    # Inject a "go back to free-drive" mode change just before homing starts.
    ipc.next_mode = DEVICE_CHANNEL_MODE_FREE_DRIVE

    import rollio_device_nero.runtime.arm as arm_mod
    real_sleep = arm_mod.time.sleep

    def fake_sleep(seconds: float) -> None:
        virtual_now[0] += max(0.0, seconds)

    arm_mod.time.sleep = fake_sleep
    try:
        ctrl.run(stop_check)
    finally:
        arm_mod.time.sleep = real_sleep

    # The mode change was delivered to the *normal* loop, so we transitioned
    # FREE_DRIVE -> FREE_DRIVE (no-op). When homing starts, the controller
    # forces itself into Disabled and refuses to listen to further mode
    # changes -- so the final reported mode must be Disabled.
    assert ctrl.mode_value == DEVICE_CHANNEL_MODE_DISABLED


def test_arm_mode_transition_into_disabled_snapshots_q_start(nero_model: NeroModel) -> None:
    q_start = np.array([0.3, -0.2, 0.0, 0.4, 0.0, 0.0, 0.0])
    ctrl, backend, ipc = _arm_controller(nero_model, "free-drive", q_start)
    ctrl.step()
    ipc.next_mode = DEVICE_CHANNEL_MODE_DISABLED
    ctrl.step()
    # After the first disabled tick the commanded p_des should be q_start (t=0).
    last_p_des = np.asarray([c[1] for c in backend.move_mit_calls[-ARM_DOF:]])
    assert np.allclose(last_p_des, q_start, atol=1e-6)


# ---------------------------------------------------------------------------
# Gripper tests
# ---------------------------------------------------------------------------


def _gripper_controller(mode: str, **kwargs) -> tuple[GripperController, FakeGripperBackend, FakeGripperIpc]:
    backend = FakeGripperBackend()
    ipc = FakeGripperIpc()
    cfg = GripperChannelConfig(mode=mode, default_force_n=2.5)
    times = iter(kwargs.get("clock_sequence", []))

    def clock() -> float:
        try:
            return next(times)
        except StopIteration:
            return 0.0

    if "clock_sequence" in kwargs:
        ctrl = GripperController(backend=backend, ipc=ipc, config=cfg, clock=clock)
    else:
        ctrl = GripperController(backend=backend, ipc=ipc, config=cfg)
    return ctrl, backend, ipc


def test_gripper_disabled_does_not_actuate() -> None:
    ctrl, backend, ipc = _gripper_controller("disabled")
    ctrl.step()
    ctrl.step()
    assert backend.move_calls == []
    assert ipc.published_modes[-1] == 0  # DEVICE_CHANNEL_MODE_DISABLED


def test_gripper_identifying_emits_triangle_open_close() -> None:
    # Step at t = 0, IDENTIFY_PERIOD_S/4, IDENTIFY_PERIOD_S/2.
    quarter = IDENTIFY_PERIOD_S * 0.25
    half = IDENTIFY_PERIOD_S * 0.5
    clock_sequence = [
        0.0,    # __init__ snapshot of identify_started_at
        0.0,    # tick 1
        quarter,  # tick 2
        half,   # tick 3 (peak open)
    ]
    ctrl, backend, _ipc = _gripper_controller("identifying", clock_sequence=clock_sequence)
    ctrl.step()
    ctrl.step()
    ctrl.step()

    targets = [m[0] for m in backend.move_calls]
    assert targets[0] == pytest.approx(0.0)
    assert targets[1] == pytest.approx(MAX_WIDTH_M * 0.5)
    assert targets[2] == pytest.approx(MAX_WIDTH_M)


def test_identify_target_function_is_periodic() -> None:
    assert identify_target(0.0) == pytest.approx(0.0)
    assert identify_target(IDENTIFY_PERIOD_S * 0.5) == pytest.approx(MAX_WIDTH_M)
    assert identify_target(IDENTIFY_PERIOD_S) == pytest.approx(0.0)
    assert identify_target(IDENTIFY_PERIOD_S * 1.5) == pytest.approx(MAX_WIDTH_M)


def test_gripper_command_following_forwards_position_with_default_force() -> None:
    ctrl, backend, ipc = _gripper_controller("command-following")
    ipc.next_pos = ParallelVector2.from_values(0, [0.04])
    ctrl.step()
    assert backend.move_calls[-1] == (0.04, 2.5)


def test_gripper_command_following_uses_kp_slot_as_force_when_nonzero() -> None:
    ctrl, backend, ipc = _gripper_controller("command-following")

    msg = ParallelMitCommand2()
    msg.timestamp_ms = 0
    msg.len = 1
    msg.position[0] = 0.05
    msg.velocity[0] = 0.0
    msg.effort[0] = 0.0
    msg.kp[0] = 7.5
    msg.kd[0] = 0.5
    ipc.next_mit = msg

    ctrl.step()
    assert backend.move_calls[-1] == (0.05, 7.5)


def test_gripper_command_following_clips_negative_widths() -> None:
    ctrl, backend, ipc = _gripper_controller("command-following")
    ipc.next_pos = ParallelVector2.from_values(0, [-0.10])
    ctrl.step()
    target, force = backend.move_calls[-1]
    assert target == 0.0
    assert force == 2.5


def test_gripper_publishes_state_each_tick() -> None:
    ctrl, _backend, ipc = _gripper_controller("free-drive")
    ctrl.step()
    assert len(ipc.published_position) == 1
    assert len(ipc.published_effort) == 1
    # Velocity not exposed by AGX backend in this test (FakeGripperBackend
    # returns a number, but the real adapter returns None) -- the runtime
    # publishes whatever the backend yields, so we verify the count == 1
    # here too.
    assert len(ipc.published_velocity) == 1
