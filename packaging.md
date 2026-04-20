# Rollio packaging

Two artifacts come out of one source tree (target: Ubuntu 24.04 / Python 3.12):

- **`rollio_<version>_<arch>.deb`** — all Rust binaries under `/usr/bin/` (including `rollio-encoder`) plus terminal/web UI bundles under `/usr/share/rollio/ui/{web,terminal}/dist/`. `Depends:` is computed from `dpkg-shlibdeps` over the staged `usr/bin/` ELFs and includes the FFmpeg closure pulled in by the encoder.
- **`rollio_device_nero-<version>-py3-none-any.whl`** — Nero hardware driver wheel. Operators install it into a venv when they actually need the AGX Nero driver. The wheel pulls Pinocchio (`pin>=3.0`) and friends from PyPI; those wheels vendor a large C++ closure (Boost, Coal, Octomap, …) via `cmeel` and intentionally stay out of the `.deb`.

## Build and pack

```bash
make build           # rust + C++ + UI (default: release)
make package         # ./build.sh all -- stages + dpkg-deb + uv build
# or one shot:
make package-all
```

`make package` does not compile. It runs `./build.sh all`, which:

1. Asserts `target/release/rollio*`, `ui/web/dist`, `ui/terminal/dist` exist.
2. Stages all Rust binaries + UI bundles into `.deb-staging/rollio/` and runs `dpkg-shlibdeps` over `usr/bin/` only.
3. Builds the Nero wheel via `uv build --wheel --out-dir dist robots/nero` (falls back to `python3 -m build --wheel` if `uv` is missing).
4. Writes the `.deb` with `dpkg-deb --root-owner-group --build` to `dist/`.

Tooling required at pack time:

- `dpkg-dev` (provides `dpkg-deb`, `dpkg-shlibdeps`)
- `uv` for the wheel (recommended): `pipx install uv` — or `python3-build` as fallback
- `make package-deps` installs the apt-side helpers (omits Python — use `uv`)

`./build.sh` accepts subcommands when you only need one artifact: `core`, `nero`, `clean`. Env overrides: `DEB_VERSION` (default `0.1.0-1`), `DEB_ARCH` (default `dpkg --print-architecture`), `DEB_DIST` (default `dist`), `STAGING` (default `.deb-staging`), `TARGET_DIR` (default `target/release`).

Example:

```bash
DEB_VERSION=0.2.0-1 DEB_DIST=/tmp/out ./build.sh core
```

Network access is required at pack time so `uv build` can resolve `pyAgxArm` from GitHub (pinned by SHA in [`robots/nero/pyproject.toml`](../robots/nero/pyproject.toml)).

## Operator install

```bash
sudo apt install ./dist/rollio_*.deb

# Optional, only if you need the Nero hardware driver:
python3 -m venv ~/rollio-venv
~/rollio-venv/bin/pip install ./dist/rollio_device_nero-*.whl
source ~/rollio-venv/bin/activate                # exposes rollio-device-agx-nero on PATH
rollio collect -c /path/to/config.toml
```

The venv is required because Ubuntu 24.04's system Python is PEP 668 externally-managed. The controller spawns `rollio-device-agx-nero` from `PATH`, so as long as the operator's shell has the venv active (or `~/rollio-venv/bin` on `PATH`), it picks up the wheel-provided console-script.

## Runtime layout (FHS) — `rollio.deb`

| Path | Purpose |
|------|---------|
| `/usr/bin/rollio`, `/usr/bin/rollio-ui-server`, `/usr/bin/rollio-control-server`, `/usr/bin/rollio-encoder`, … | Rust binaries (encoder included) |
| `/usr/share/rollio/ui/web/dist/` | Built web UI |
| `/usr/share/rollio/ui/terminal/dist/` | Built terminal UI (run with `node`) |

The Nero wheel installs into the operator's venv (`<venv>/lib/python3.12/site-packages/rollio_device_nero/`) and exposes `<venv>/bin/rollio-device-agx-nero`.

## Environment variables

| Variable | Meaning |
|----------|---------|
| `ROLLIO_SHARE_DIR` | Directory that **contains** `ui/web/dist/index.html` (same shape as the repo or `/usr/share/rollio`). Overrides auto-detection. |
| `ROLLIO_STATE_DIR` | Writable directory for child process cwd, logs under `rollio-logs` / `rollio-setup-logs`, and related state. |

If neither `ROLLIO_STATE_DIR` nor `XDG_STATE_HOME` / `$HOME` is set, the controller falls back to `<workspace>/target/rollio-state` (compile-time workspace), which suits in-tree development.

## Controller share-root resolution order (web UI)

1. `ROLLIO_SHARE_DIR` if valid
2. Compile-time workspace root if `ui/web/dist` exists there (developer checkout)
3. `/usr/share/rollio` if packaged assets are present
