import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(scriptDir);
const workspaceRoot = path.dirname(uiDir);
const outputDir = path.join(uiDir, "wasm");
const outputPath = path.join(outputDir, "harri-core.wasm");
const crateManifestPath = path.join(
  workspaceRoot,
  "external",
  "ascii-video-renderer",
  "Cargo.toml",
);
const buildResult = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--lib",
    "--manifest-path",
    crateManifestPath,
  ],
  {
    cwd: workspaceRoot,
    encoding: "utf8",
  },
);

if (buildResult.error) {
  console.error(
    "rollio-ui: failed to launch Cargo while building the shared Harri WASM engine.\n" +
      `${buildResult.error.message}\n`,
  );
  process.exit(1);
}

if (buildResult.status !== 0) {
  const output = `${buildResult.stdout ?? ""}${buildResult.stderr ?? ""}`;
  if (output.includes("wasm32-unknown-unknown")) {
    console.error(
      "rollio-ui: failed to build the shared Harri WASM engine.\n" +
        "Install the target with `rustup target add wasm32-unknown-unknown` and retry.\n",
    );
  }
  process.stderr.write(output);
  process.exit(buildResult.status ?? 1);
}

const builtWasmPath = path.join(
  workspaceRoot,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "ascii_video_renderer.wasm",
);
await mkdir(outputDir, { recursive: true });
await copyFile(builtWasmPath, outputPath);
