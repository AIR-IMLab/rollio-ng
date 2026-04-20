# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Rollio is a multi-process CLI framework for robotic teleoperation data collection. It is a Cargo workspace (Rust crates under the repo root and `test/`) + C++ camera drivers under `cameras/` with shared interop headers in `cpp/common/` + a TypeScript/React Ink terminal UI (`ui/terminal/`). All inter-process communication uses iceoryx2 (zero-copy shared-memory IPC) via a git submodule at `third_party/iceoryx2`. The `ascii-video-renderer` submodule lives at `third_party/ascii-video-renderer` and is used by the terminal UI’s native ASCII N-API addon (not a root workspace member).

The project is in early development — most binary crates are stubs. The `rollio-types` library crate has real integration tests for config parsing and message types.

### Build & test commands

See `Makefile` and `README.md` for standard commands. Key shortcuts:

- **Full build:** `make build` (runs Rust + C++ + UI; Rust uses `CARGO_BUILD_ARGS` which defaults to `--release`)
- **Packaging (Ubuntu 24.04):** `make build` then `make package` (delegates to `./build.sh all`; produces a single `rollio_*.deb` with all Rust binaries + UI bundles, and a separate `rollio_device_nero-*.whl` for the Nero driver, under `dist/`). Needs `dpkg-dev` and `uv` on PATH; optional `make package-deps` for the apt side — see `packaging/README.md`
- **Rust only:** `cargo build --workspace` / `cargo test --workspace` (add `--release` to match `make build`, or use `make rust-build`)
- **Lint:** `cargo clippy --workspace -- -D warnings`
- **Format check:** `cargo fmt --all -- --check`
- **C++ build:** `cmake -B cameras/build -S cameras -DCMAKE_CXX_COMPILER=g++ && cmake --build cameras/build`
- **UI:** `cd ui/terminal && npm install && npm run build`
- **UI run:** `cd ui/terminal && node dist/index.js`

### Non-obvious caveats

- **Git submodules required:** Initialize `third_party/iceoryx2` and `third_party/ascii-video-renderer` before builds that compile the full stack. Run `git submodule update --init --recursive` if directories are empty.
- **C++ compiler:** The default `c++` symlink points to Clang 18, which may fail to find `<iostream>` on this platform. Use `-DCMAKE_CXX_COMPILER=g++` when running CMake to use GCC instead.
- **Rust 1.85+:** The workspace requires Rust 1.85 or newer. The VM default may be older; use `rustup install 1.85.0 && rustup default 1.85.0` if needed.
- **libstdc++ symlink:** If Clang linker fails with `cannot find -lstdc++`, create the symlink: `sudo ln -sf /usr/lib/gcc/x86_64-linux-gnu/13/libstdc++.so /usr/lib/x86_64-linux-gnu/libstdc++.so`.
- **No Docker or external services required.** The entire stack runs locally without databases, containers, or network services.
