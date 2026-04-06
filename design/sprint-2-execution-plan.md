# Sprint 2 Execution Plan

This document captures the approved execution plan for Sprint 2 after
reviewing the existing repository state, the AIRBOT driver sources in
`external/airbot-driver-1`, and the Python free-drive / dynamics examples in
`external/kdl_demos`.

## Executive Summary

Sprint 2 will deliver a driver-centric runtime where:

- `rollio collect -c <config>` becomes the main runtime entrypoint.
- The Controller launches the preview stack and the configured device drivers.
- Pseudo devices work end-to-end first.
- The existing Visualizer and TUI are integrated under Controller ownership.
- Clean shutdown via `ControlEvent::Shutdown` is implemented and verified.
- RealSense is added as a real C++ camera driver.
- AIRBOT Play is added as a real Python robot driver.

Execution order:

1. Expand shared runtime/config contract.
2. Implement pseudo camera.
3. Implement pseudo robot.
4. Turn Controller into `rollio collect`.
5. Add minimal Visualizer/UI controller launch contract.
6. Add RealSense driver.
7. Add AIRBOT Python driver.
8. Run targeted validation and smoke tests.

## Scope

### In Scope

- richer config schema for real devices
- Controller orchestration
- pseudo camera runtime
- pseudo robot runtime
- clean shutdown via `ControlEvent::Shutdown`
- Visualizer/UI integration under Controller ownership
- RealSense driver
- AIRBOT Play driver
- pseudo-device smoke tests
- hardware validation paths for RealSense and AIRBOT

### Explicitly Out of Scope

These are Sprint 3+ items and must not be pulled into Sprint 2:

- teleop routing behavior
- episode lifecycle controls
- recording state machine
- UI-originated episode commands
- encoder / assembler / storage work
- warning / backpressure UI integration beyond the already shipped preview
  stack

## Current Baseline

### Already Usable

- `visualizer/` already subscribes to:
  - `camera/<name>/frames`
  - `robot/<name>/state`
- `ui/` already renders:
  - camera previews
  - robot states
- `rollio-types/` already contains:
  - IPC message types
  - initial config parsing
  - tests for messages/config
- `test-publisher/` demonstrates Rust-side iceoryx2 publish logic

### Still Stubbed or Incomplete

- `controller/src/main.rs`
- `pseudo-robot/src/main.rs`
- `cpp/pseudo-camera/src/main.cpp`

### Hardware References Now Available

- `external/airbot-driver-1`
  - C++ library
  - Python bindings
  - hardware tests
- `external/kdl_demos`
  - Python gravity compensation example
  - Python virtual-wall / free-drive-style example
  - Pinocchio-based inverse dynamics helpers

## Key Design Decisions

### Controller remains Rust

Reason:

- already part of the workspace
- good fit for process supervision and signal handling
- matches the component architecture

### Pseudo robot remains Rust

Reason:

- shared IPC/messages already live in Rust
- simplest place to validate `RobotState` / `RobotCommand` runtime behavior

### Pseudo camera and RealSense remain C++

Reason:

- camera drivers were planned in C++
- RealSense native integration is straightforward there
- keeps camera runtime aligned with hardware SDKs

### AIRBOT becomes Python-first

Reason:

- `external/kdl_demos/gravity_comp.py` already shows the exact free-drive
  pattern we want
- `airbot_hardware_py` exists in `external/airbot-driver-1`
- Python examples now exist for both hardware interaction and gravity
  compensation behavior
- this minimizes custom control-law invention for Sprint 2

### Runtime configuration must be structured

Every runtime process will accept:

- `--config <path>`
- `--config-inline <toml>`

No bespoke long argument lists for runtime mode.

### Topic/service names must be centralized

To avoid mismatches across Controller, drivers, and Visualizer, shared helpers
for topic naming will be introduced in `rollio-types`.

Likely services:

- `camera/<name>/frames`
- `robot/<name>/state`
- `robot/<name>/command`
- `control/events`

## Workstream A — Expand the Shared Runtime Contract

### Goal

Make the config expressive enough to launch all Sprint 2 processes, including
pseudo devices, RealSense, and AIRBOT.

### Files To Modify

- `rollio-types/src/config.rs`
- `rollio-types/src/lib.rs`
- `rollio-types/tests/config.rs`
- `config/config.example.toml`

### Files Likely To Add

- `rollio-types/src/topic_names.rs` or `rollio-types/src/ipc.rs`
- `config/config.realsense.example.toml`
- `config/config.airbot.example.toml`
  or a combined `config/config.hardware.example.toml`

### Planned Changes

1. Replace the flat device model with structured camera and robot configs.
2. Add preview/runtime launch config sections for Visualizer and UI.
3. Add shared service-name helpers.
4. Strengthen validation for driver types, stream kinds, and pair references.

### Acceptance Criteria

- pseudo config parses and validates
- RealSense config parses and validates
- AIRBOT config parses and validates
- invalid combinations produce descriptive errors
- topic naming is derived consistently across modules

### Tests

Extend `rollio-types/tests/config.rs` to cover:

- pseudo example config
- RealSense stream parsing
- AIRBOT robot parsing
- unknown driver rejection
- invalid stream rejection
- unknown pair references
- invalid required fields for command-following robots

## Workstream B — Implement Pseudo Camera Driver

### Goal

Replace the C++ stub with a real synthetic camera process that publishes frames
and shuts down cleanly.

### Files To Modify

- `cpp/CMakeLists.txt`
- `cpp/pseudo-camera/CMakeLists.txt`
- `cpp/pseudo-camera/src/main.cpp`

### Files Likely To Add

- `cpp/pseudo-camera/src/cli.cpp`
- `cpp/pseudo-camera/src/runtime.cpp`
- `cpp/pseudo-camera/src/json.cpp`
- `cpp/pseudo-camera/src/pattern.cpp`
- helper headers under `cpp/pseudo-camera/include/`

### Planned Changes

Implement:

- `probe`
- `validate`
- `capabilities`
- `run --config`
- `run --config-inline`

`run` will:

- publish RGB frames to `camera/<name>/frames`
- fill `CameraFrameHeader`
- generate synthetic image patterns
- maintain monotonic timestamp and frame index
- run at configured fps
- listen for `ControlEvent::Shutdown` on `control/events`
- exit quickly and cleanly

### Acceptance Criteria

- `probe` returns valid JSON ids
- `validate` succeeds for valid pseudo ids
- `capabilities` reports usable options
- `run` produces frames visible in Visualizer/UI
- shutdown occurs promptly after a control event

## Workstream C — Implement Pseudo Robot Driver

### Goal

Replace the Rust stub with a real pseudo robot that supports both free-drive
style publication and command-following.

### Files To Modify

- `pseudo-robot/Cargo.toml`
- `pseudo-robot/src/main.rs`

### Files Likely To Add

- `pseudo-robot/src/cli.rs`
- `pseudo-robot/src/runtime.rs`
- `pseudo-robot/src/ipc.rs`
- `pseudo-robot/src/json.rs`
- `pseudo-robot/src/model.rs`

### Planned Changes

Implement:

- `probe`
- `validate`
- `capabilities`
- `run --config`
- `run --config-inline`

Runtime modes:

- `free-drive`: publish smooth synthetic state
- `command-following`: subscribe to `robot/<name>/command` and converge toward
  commanded targets

Listen for:

- mode-switch events
- shutdown events

### Acceptance Criteria

- free-drive publishes stable robot state
- command-following tracks step commands
- mode-switch is supported
- clean shutdown works

## Workstream D — Turn Controller Into `rollio collect`

### Goal

Make the controller the actual entrypoint that launches the system and owns
lifecycle and shutdown behavior.

### Files To Modify

- `controller/Cargo.toml`
- `controller/src/main.rs`

### Files Likely To Add

- `controller/src/cli.rs`
- `controller/src/config_load.rs`
- `controller/src/process_spec.rs`
- `controller/src/supervisor.rs`
- `controller/src/shutdown.rs`
- `controller/src/logging.rs`
- `controller/src/control_pub.rs`

### Planned Changes

1. Promote the package to `rollio`.
2. Implement:
   - `rollio collect -c <path>`
   - `rollio collect --config-inline <toml>`
3. Build launch specs for:
   - Visualizer
   - UI
   - pseudo camera(s)
   - pseudo robot(s)
   - RealSense driver(s)
   - AIRBOT driver(s)
4. Supervise child processes.
5. Redirect stdio for non-UI children.
6. Publish `ControlEvent::Shutdown` on Ctrl+C, SIGTERM, or UI exit.

### Acceptance Criteria

- `rollio collect -c config/config.example.toml` launches the pseudo stack
- UI owns the terminal correctly
- Visualizer and drivers do not corrupt TUI output
- Ctrl+C exits cleanly
- crash detection works

## Workstream E — Add Controller-Facing Launch Contracts To Visualizer And UI

### Goal

Keep changes thin while making the preview stack controller-launchable.

### Files To Modify

- `visualizer/src/main.rs`
- `ui/package.json`
- `ui/src/index.tsx`
- `ui/src/App.tsx`
- `ui/src/lib/websocket.ts`

### Files Likely To Add

- `visualizer/src/runtime_config.rs`
- `ui/src/lib/runtime-config.ts`

### Planned Changes

Visualizer:

- add `--config`
- add `--config-inline`
- derive camera/robot names and preview settings from config

UI:

- replace hardcoded `ws://localhost:9090`
- make websocket endpoint controller-configurable

### Acceptance Criteria

- Controller can launch Visualizer without bespoke comma-separated lists
- Controller can launch UI against the correct websocket endpoint
- existing UI rendering behavior remains intact

## Workstream F — Implement RealSense Driver

### Goal

Add a real hardware camera driver with safe no-hardware behavior.

### Files To Modify

- `cpp/CMakeLists.txt`

### Files To Add

- `cpp/realsense/CMakeLists.txt`
- `cpp/realsense/src/main.cpp`
- likely helper files:
  - `device.cpp`
  - `profiles.cpp`
  - `runtime.cpp`
  - `json.cpp`

### Planned Changes

Implement:

- `probe`
- `validate`
- `capabilities`
- `run --config`
- `run --config-inline`

Support stream kinds:

- color
- depth
- infrared

Runtime:

- open selected device/stream
- publish frames to `camera/<name>/frames`
- use `CameraFrameHeader`
- one configured stream per process

### Acceptance Criteria

- no-hardware probe returns empty list or clear failure
- invalid serial errors cleanly
- valid hardware path publishes frames to preview stack

## Workstream G — Implement AIRBOT Play Driver In Python

### Goal

Add a Python runtime driver for AIRBOT Play that supports:

- free-drive via gravity compensation and MIT mode
- command-following via live state plus PVT control

### Files To Add

Preferred structure:

- `airbot-play/pyproject.toml`
- `airbot-play/rollio_airbot_play/__init__.py`
- `airbot-play/rollio_airbot_play/main.py`
- `airbot-play/rollio_airbot_play/cli.py`
- `airbot-play/rollio_airbot_play/runtime.py`
- `airbot-play/rollio_airbot_play/ipc.py`
- `airbot-play/rollio_airbot_play/config.py`
- `airbot-play/rollio_airbot_play/free_drive.py`
- `airbot-play/rollio_airbot_play/command_following.py`
- `airbot-play/tests/...`

### External References

- `external/airbot-driver-1`
- `external/kdl_demos/gravity_comp.py`
- `external/kdl_demos/vitual_floor.py`
- `external/kdl_demos/src/airbot_ng/kdl/pinocchio.py`
- `external/airbot-driver-1/test/test_arm_hardware.cpp`

### Planned Runtime Design

#### Subcommands

- `probe`
- `validate`
- `capabilities`
- `run --config`
- `run --config-inline`

#### `probe`

Enumerate viable CAN interfaces / AIRBOT-related runtime candidates and return
structured JSON.

#### `validate`

- instantiate executor
- create AIRBOT arm object
- try `init(...)`
- return success/failure JSON

#### `capabilities`

Return JSON describing:

- supported modes
- DoF
- interface expectations
- optional end-effector metadata
- product metadata if derivable

#### `run` free-drive mode

Base this on `gravity_comp.py`:

- create executor + arm
- init on configured interface
- enable arm
- switch to MIT control mode
- loop:
  - read current joint state
  - compute gravity compensation via `PinocchioModel.inverse_dynamics(...)`
  - apply conservative torque scaling
  - send `arm.mit(...)`
  - publish `RobotState` to iceoryx2
- on shutdown:
  - switch back to PVT
  - return to safe state
  - disable and uninit

#### `run` command-following mode

- init arm
- enable arm
- switch to PVT mode
- subscribe to `robot/<name>/command`
- translate target positions to `arm.pvt(...)`
- publish `RobotState` continuously

### Packaging / Dependency Plan

Primary plan:

- keep AIRBOT driver as its own Python subproject
- import:
  - `airbot_hardware_py`
  - `airbot_ng.kdl.pinocchio`

Fallback if packaging friction appears during execution:

- controlled repo-local import path usage for Sprint 2 only

### Acceptance Criteria

- invalid/no hardware path fails clearly
- free-drive mode runs from Python and publishes live state
- command-following mode tracks received commands
- shutdown is clean
- Controller can launch the driver reproducibly

## Workstream H — Docs, Examples, And Validation Polish

### Files To Modify

- `README.md`
- `Makefile`
- optionally add docs under `design/` or `docs/`

### Planned Changes

- update repo docs to reflect Sprint 2 runtime
- document AIRBOT Python dependency/setup path
- document RealSense runtime expectations
- document smoke test commands
- keep example configs aligned with the new schema

## Milestones

### Milestone 1 — Shared contract done

Checkpoint:

- config examples parse
- device-specific fields modeled
- service-name helpers exist

### Milestone 2 — Pseudo drivers done

Checkpoint:

- pseudo camera publishes frames
- pseudo robot publishes state and follows commands

### Milestone 3 — Controller-owned pseudo stack done

Checkpoint:

- `rollio collect -c config/config.example.toml`
- TUI shows:
  - live pseudo camera previews
  - live pseudo robot state
- Ctrl+C exits cleanly

### Milestone 4 — RealSense added

Checkpoint:

- no-hardware-safe behavior proven
- hardware preview works when device is present

### Milestone 5 — AIRBOT Python driver added

Checkpoint:

- no-hardware validate path works
- hardware free-drive / command-following path works
- AIRBOT state appears in the existing preview stack

## Testing Strategy

### Automated Rust Tests

- `cargo test -p rollio-types`
- `cargo test -p rollio-pseudo-robot`
- `cargo test -p rollio`
- `cargo test -p rollio-visualizer`

### Automated C++ Build/Tests

- `cmake -B cpp/build -S cpp -DCMAKE_CXX_COMPILER=g++`
- `cmake --build cpp/build`
- `ctest --test-dir cpp/build --output-on-failure` if tests are added there

### UI Tests

- `cd ui && npm test`
- `cd ui && npm run build`

### Python AIRBOT Tests

- use `pytest` under the AIRBOT Python subproject
- use mocked bindings where hardware is not required

### End-To-End Smoke Tests

#### Pseudo smoke

- run `rollio collect -c config/config.example.toml`
- verify:
  - UI starts
  - previews update
  - robot bars update
  - Ctrl+C exits cleanly

#### RealSense smoke

- run with RealSense config
- verify preview appears

#### AIRBOT smoke

- run with AIRBOT config
- verify state appears in UI
- verify free-drive or command-following behavior
- verify clean shutdown

## Major Risks And Mitigations

### Risk 1 — Config changes ripple across many modules

Mitigation:

- do shared config/topic helpers first
- update all launch/runtime components against one shared contract

### Risk 2 — Controller packaging rename to `rollio`

Mitigation:

- do this early, not late
- keep launch-path assumptions centralized in Controller modules

### Risk 3 — AIRBOT Python packaging/import friction

Mitigation:

- Python-first remains the right plan
- primary path: proper subproject + install/import contract
- fallback: repo-local import path only if needed for Sprint 2

### Risk 4 — Free-drive safety / stability

Mitigation:

- base implementation directly on the provided examples
- use conservative defaults
- keep command-following simpler than free-drive compensation logic
- require explicit mode selection

### Risk 5 — RealSense build portability

Mitigation:

- compile target conditionally and cleanly
- keep driver optional if dependency absent, but supported on this VM

## Definition Of Done

Sprint 2 is done when all of the following are true:

1. `rollio collect -c config/config.example.toml` works.
2. Controller launches:
   - UI
   - Visualizer
   - pseudo drivers
3. Existing TUI shows:
   - camera previews
   - robot state
4. Ctrl+C or UI exit shuts down all children cleanly.
5. RealSense support exists with no-hardware-safe behavior.
6. AIRBOT Play support exists in Python, using the provided examples as the
   implementation basis.
7. Documentation and example configs are updated.
8. Automated tests and manual smoke checks pass for the pseudo path, with
   hardware checkpoints documented for RealSense and AIRBOT.

## Recommended Execution Order

1. shared config + topic naming helpers
2. pseudo camera
3. pseudo robot
4. controller CLI and supervision
5. visualizer/UI launch contract
6. pseudo end-to-end smoke and cleanup hardening
7. RealSense
8. AIRBOT Python driver
9. docs and final validation sweep

## Implementation Preference For AIRBOT

For AIRBOT specifically:

- `external/airbot-driver-1` is treated as the hardware binding source
- `external/kdl_demos` is treated as the behavior reference for free-drive

The examples will be converted into a proper Rollio runtime process with:

- structured config input
- iceoryx2 publication/subscription
- explicit subcommands
- clean shutdown
- controller-managed launching
