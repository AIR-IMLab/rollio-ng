"""Damped-pseudo-inverse Cartesian IK for the AGX Nero arm.

The Nero arm has 7-DOF (i.e. one redundant DOF), so we cannot use a
closed-form analytical inverse like airbot_play_rust does. Instead we run
a closed-loop IK (CLIK) iteration in the link7 LOCAL frame:

    while iter < max_iter:
        oMi    = FK(q)
        err6   = pin.log6(oMi.actInv(target))      # 6-vec twist from oMi to target
        if ||err6|| < tol: break
        J      = pin.computeJointJacobian(model, data, q, link7_id)   # 6 x 7 in LOCAL
        dq     = solve((J.T @ J + lambda^2 * I) , J.T @ err6)         # damped pseudo-inverse
        q     += step * dq

This converges in a couple of iterations when warm-started from `q_meas`
under teleop where consecutive Cartesian targets are close together.
"""

from __future__ import annotations

import numpy as np

from .gravity import NeroModel
from .query import ARM_JOINT_POSITION_MAX, ARM_JOINT_POSITION_MIN

_DEFAULT_MAX_ITER: int = 50
_DEFAULT_DAMPING: float = 1e-2
_DEFAULT_TOL: float = 1e-4   # ~0.1 mm and ~0.1 mrad for translation/rotation in pin.log6
_DEFAULT_STEP: float = 1.0

_JOINT_LB: np.ndarray = np.asarray(ARM_JOINT_POSITION_MIN, dtype=float)
_JOINT_UB: np.ndarray = np.asarray(ARM_JOINT_POSITION_MAX, dtype=float)


def _pose7_to_se3(pin: object, pose: list[float] | np.ndarray) -> object:
    values = np.asarray(pose, dtype=float).reshape(7)
    translation = values[0:3]
    qx, qy, qz, qw = values[3], values[4], values[5], values[6]
    quat = pin.Quaternion(float(qw), float(qx), float(qy), float(qz))  # type: ignore[attr-defined]
    quat.normalize()
    return pin.SE3(quat.toRotationMatrix(), translation)  # type: ignore[attr-defined]


def solve(
    nero: NeroModel,
    target_pose7: list[float] | np.ndarray,
    *,
    q0: np.ndarray | None = None,
    max_iter: int = _DEFAULT_MAX_ITER,
    damping: float = _DEFAULT_DAMPING,
    tol: float = _DEFAULT_TOL,
    step: float = _DEFAULT_STEP,
) -> tuple[np.ndarray, bool, float]:
    """Solve `IK(target) ≈ q` warm-started from `q0`.

    Returns `(q, converged, final_err_norm)`. `converged` is True iff the
    final 6D error norm drops below `tol`. The returned `q` is always
    clipped to the URDF joint limits, even when the iteration does not
    converge -- the runtime will still send it (with caller-imposed kp/kd)
    so the operator can see a partial response instead of nothing.
    """
    pin = nero._pin  # noqa: SLF001 - intentional access; gravity owns the import
    target = _pose7_to_se3(pin, target_pose7)

    q = np.zeros(nero.nq, dtype=float) if q0 is None else np.array(q0, dtype=float, copy=True)
    if q.shape != (nero.nq,):
        raise ValueError(f"q0 must have shape ({nero.nq},), got {q.shape}")

    err_norm = float("inf")
    for _ in range(max_iter):
        oMi = nero.forward_kinematics(q)
        # `actInv(target)` gives target expressed in the link7 local frame;
        # `log6` returns the 6-twist that maps current → target in that frame.
        err = np.asarray(pin.log6(oMi.actInv(target)).vector, dtype=float)
        err_norm = float(np.linalg.norm(err))
        if err_norm < tol:
            return _clip_to_limits(q), True, err_norm

        jac = nero.frame_jacobian(q)            # 6 x nv in link7's LOCAL frame
        # Damped least-squares: dq = (J^T J + λ^2 I)^-1 J^T e.
        jt_j = jac.T @ jac + (damping * damping) * np.eye(nero.nv)
        try:
            dq = np.linalg.solve(jt_j, jac.T @ err)
        except np.linalg.LinAlgError:
            return _clip_to_limits(q), False, err_norm
        q = q + step * dq
        q = _clip_to_limits(q)

    return q, False, err_norm


def _clip_to_limits(q: np.ndarray) -> np.ndarray:
    return np.minimum(np.maximum(q, _JOINT_LB), _JOINT_UB)


__all__ = ["solve"]
