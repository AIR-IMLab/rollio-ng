#!/usr/bin/env bash
# Pack already-built artifacts into a Debian package and a Python wheel.
#
#   ./build.sh [all|core|nero|clean]
#
# `all` (the default) produces two artifacts in $DEB_DIST (default: dist/):
#   * rollio_<ver>_<arch>.deb              all Rust binaries (incl. encoder) + UI bundles
#   * rollio_device_nero-<ver>-py3-none-any.whl  Nero hardware driver wheel
#
# This script does NOT compile. Run `make build` first (or `make package-all`).
#
# Env overrides:
#   DEB_VERSION  package version (default: 0.1.0-1)
#   DEB_ARCH     dpkg architecture (default: dpkg --print-architecture)
#   DEB_DIST     output directory (default: dist)
#   STAGING      staging tree   (default: .deb-staging)
#   TARGET_DIR   cargo profile target dir (default: target/release)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

DEB_VERSION="${DEB_VERSION:-0.1.0-1}"
DEB_ARCH="${DEB_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo amd64)}"
DEB_DIST="${DEB_DIST:-dist}"
STAGING="${STAGING:-.deb-staging}"
TARGET_DIR="${TARGET_DIR:-target/release}"

# Binaries omitted from dpkg-shlibdeps (still shipped). Encoder links the full
# FFmpeg stack; Depends are not generated for it until packaging is finalized.
SHLIBDEPS_EXCLUDE_BINS=(
    rollio-encoder
)

# All Rust binaries shipped in /usr/bin (encoder included for shipping).
CORE_BINS=(
    rollio
    rollio-encoder
    rollio-visualizer
    rollio-control-server
    rollio-ui-server
    rollio-teleop-router
    rollio-episode-assembler
    rollio-storage
    rollio-monitor
    rollio-device-pseudo
    rollio-device-airbot-play
    rollio-device-v4l2
    rollio-bus-tap
    rollio-test-publisher
)

CORE_STAGING="$STAGING/rollio"

log()  { printf '\033[1;34m[build.sh]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[build.sh]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[build.sh]\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
    local cmd="$1" hint="${2:-}"
    command -v "$cmd" >/dev/null 2>&1 || die "missing required tool: $cmd${hint:+ ($hint)}"
}

preflight_deb() {
    require_cmd dpkg-deb       "apt install dpkg-dev"
    require_cmd dpkg-shlibdeps "apt install dpkg-dev"
    require_cmd file           "apt install file"
}

preflight_wheel() {
    if command -v uv >/dev/null 2>&1; then
        WHEEL_BUILDER=(uv build --wheel)
    elif python3 -c 'import build' >/dev/null 2>&1; then
        WHEEL_BUILDER=(python3 -m build --wheel)
    else
        die "need uv (preferred) or python3-build for the Nero wheel; try \`pipx install uv\`"
    fi
}

assert_built() {
    for b in "${CORE_BINS[@]}"; do
        [[ -x "$TARGET_DIR/$b" ]] || die "missing $TARGET_DIR/$b -- run \`make build\` (or \`make package-all\`) first"
    done
    [[ -d ui/web/dist ]]      || die "missing ui/web/dist -- run \`make ui-build\` (or \`make build\`) first"
    [[ -d ui/terminal/dist ]] || die "missing ui/terminal/dist -- run \`make ui-build\` (or \`make build\`) first"
}

run_shlibdeps() {
    # $1 = staging root, $2 = substvars output path, $3 = package name
    # Limit shlibdeps to /usr/bin/ ELFs only (no vendored Python trees).
    # dpkg-shlibdeps insists on reading debian/control from CWD; synthesize a
    # minimal one per package in a temp dir under $STAGING and run from there.
    local root="$1" subst="$2" pkg="$3"
    local subst_abs root_abs ctldir
    subst_abs="$(realpath -m "$subst")"
    root_abs="$(realpath "$root")"
    ctldir="$(realpath "$STAGING")/.shlibdeps-$pkg"
    rm -rf "$ctldir"
    install -d "$ctldir/debian"
    cat > "$ctldir/debian/control" <<EOF
Source: $pkg
Section: video
Priority: optional
Maintainer: Rollio Maintainers <rollio@localhost>

Package: $pkg
Architecture: any
Description: shlibdeps stub for $pkg
 Synthetic control file used only by build.sh to satisfy dpkg-shlibdeps.
EOF
    rm -f "$subst_abs"
    local elfs=() exclude name
    while IFS= read -r -d '' f; do
        name="$(basename "$f")"
        local skip=0
        for exclude in "${SHLIBDEPS_EXCLUDE_BINS[@]}"; do
            if [[ "$name" == "$exclude" ]]; then
                skip=1
                break
            fi
        done
        [[ "$skip" -eq 1 ]] && continue
        if file -b "$f" | grep -qE 'ELF.*(executable|shared object)'; then
            elfs+=("$(realpath "$f")")
        fi
    done < <(find "$root_abs/usr/bin" -maxdepth 1 -type f -print0 2>/dev/null)
    [[ ${#elfs[@]} -gt 0 ]] || die "no ELFs found under $root/usr/bin for shlibdeps"
    ( cd "$ctldir" && dpkg-shlibdeps -T"$subst_abs" -pshlibs "${elfs[@]}" )
}

extract_shlibs_depends() {
    grep '^shlibs:Depends=' "$1" 2>/dev/null | head -1 | cut -d= -f2-
}

build_core() {
    preflight_deb
    assert_built
    log "Staging rollio -> $CORE_STAGING"
    rm -rf "$CORE_STAGING"
    install -d "$CORE_STAGING/DEBIAN" \
               "$CORE_STAGING/usr/bin" \
               "$CORE_STAGING/usr/share/rollio/ui/web" \
               "$CORE_STAGING/usr/share/rollio/ui/terminal"
    for b in "${CORE_BINS[@]}"; do
        install -m755 "$TARGET_DIR/$b" "$CORE_STAGING/usr/bin/"
    done
    cp -a ui/web/dist      "$CORE_STAGING/usr/share/rollio/ui/web/dist"
    cp -a ui/terminal/dist "$CORE_STAGING/usr/share/rollio/ui/terminal/dist"

    local subst="$STAGING/substvars-rollio"
    log "Computing rollio Depends via dpkg-shlibdeps"
    run_shlibdeps "$CORE_STAGING" "$subst" rollio
    local shlibs
    shlibs="$(extract_shlibs_depends "$subst")"
    [[ -n "$shlibs" ]] || die "dpkg-shlibdeps produced no Depends for rollio"

    cat > "$CORE_STAGING/DEBIAN/control" <<EOF
Package: rollio
Version: $DEB_VERSION
Architecture: $DEB_ARCH
Maintainer: Rollio Maintainers <rollio@localhost>
Section: video
Priority: optional
Depends: nodejs, $shlibs
Description: Rollio robotics data collection framework
 Ships controller binaries and the terminal/web UI bundles under
 /usr/share/rollio. Shared-library Depends are derived from all shipped
 binaries except rollio-encoder (install FFmpeg/Ubuntu libav* packages
 separately if you use the encoder). The Nero hardware driver is shipped
 separately as the rollio_device_nero Python wheel.
EOF

    install -d "$DEB_DIST"
    local out="$DEB_DIST/rollio_${DEB_VERSION}_${DEB_ARCH}.deb"
    log "Building $out"
    dpkg-deb --root-owner-group --build "$CORE_STAGING" "$out" >/dev/null
    printf '%s\n' "$out"
}

build_nero() {
    preflight_wheel
    [[ -f robots/nero/pyproject.toml ]] || die "robots/nero/pyproject.toml not found"
    install -d "$DEB_DIST"
    log "Building Nero wheel via ${WHEEL_BUILDER[*]}"
    # `uv build` and `python -m build` both accept a project directory.
    "${WHEEL_BUILDER[@]}" --out-dir "$DEB_DIST" robots/nero >&2
    # Print resulting wheel paths (newest match wins for matching name).
    find "$DEB_DIST" -maxdepth 1 -name 'rollio_device_nero-*.whl' -printf '%p\n' | sort
}

clean() {
    log "Removing $STAGING and $DEB_DIST"
    rm -rf "$STAGING" "$DEB_DIST"
}

cmd="${1:-all}"
case "$cmd" in
    core)
        out="$(build_core)"
        log "Done: $out"
        ;;
    nero)
        outs="$(build_nero)"
        log "Done:"
        printf '  %s\n' $outs >&2
        ;;
    all)
        c="$(build_core)"
        n="$(build_nero)"
        log "All artifacts:"
        printf '  %s\n' "$c" $n >&2
        ;;
    clean)
        clean
        ;;
    -h|--help|help)
        awk '/^#!/ {next} /^#/ {sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
        ;;
    *)
        die "unknown subcommand: $cmd (try: all|core|nero|clean)"
        ;;
esac
