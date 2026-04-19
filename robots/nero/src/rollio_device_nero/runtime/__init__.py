"""Per-channel control loops and the device-level orchestrator.

Modules here import `pyAgxArm`, `pinocchio` and `iceoryx2` lazily so that
the package can be imported (for `probe` / `validate` / `query` JSON output)
without hardware bindings present.
"""
