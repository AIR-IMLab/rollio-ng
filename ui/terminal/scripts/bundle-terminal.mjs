// Bundle the terminal UI for production / .deb install.
//
// Produces a flat dist/:
//   dist/index.js                  -- main entry, run as `node dist/index.js`
//   dist/native-rust.worker.js     -- Worker entry (separate file required by
//                                     `new Worker(url)` semantics)
//   dist/package.json              -- {"type": "module"} so Node parses the
//                                     bundles as ESM even when the parent
//                                     ui/terminal/package.json is absent
//                                     (i.e. inside the installed .deb tree).
//
// `sharp` is the only runtime dependency left external: it ships a per-arch
// native addon and resolves its `@img/*` optional deps via the surrounding
// node_modules tree. Everything else (react, ink, ws, react/jsx-runtime, all
// internal modules) is inlined.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(scriptDir);
const distDir = path.join(uiDir, "dist");
const vendorDir = path.join(uiDir, ".deb-vendor");
const vendorNodeModules = path.join(vendorDir, "node_modules");

const sharedOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  jsx: "automatic",
  // sharp ships per-arch native bindings; vendor its node_modules tree at
  // packaging time instead of trying to bundle .node files.
  external: ["sharp"],
  // ink statically imports `react-devtools-core` from its devtools.js, but
  // only ever dynamic-imports devtools.js when DEV=true. Aliasing keeps that
  // bare specifier from breaking ESM resolution at startup; the stub throws
  // if anything ever does call it.
  alias: {
    "react-devtools-core": path.join(scriptDir, "stubs/react-devtools-core.mjs"),
  },
  // Bundled CJS deps (e.g. signal-exit) call `require()` lazily for Node
  // builtins. esbuild leaves those calls as-is in ESM output, so we expose
  // a real `require` via createRequire(import.meta.url) at the top of each
  // bundle. Nothing else here uses dynamic require.
  banner: {
    js: "import { createRequire as __rollioCreateRequire } from 'node:module'; const require = __rollioCreateRequire(import.meta.url);",
  },
};

await mkdir(distDir, { recursive: true });

await build({
  ...sharedOptions,
  entryPoints: [path.join(uiDir, "src/index.tsx")],
  outfile: path.join(distDir, "index.js"),
});

await build({
  ...sharedOptions,
  entryPoints: [path.join(uiDir, "src/lib/renderers/native-rust.worker.ts")],
  outfile: path.join(distDir, "native-rust.worker.js"),
});

await writeFile(
  path.join(distDir, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

// Vendor sharp + its runtime dependency closure into .deb-vendor/node_modules
// so packaging can stage the exact set Node will resolve at runtime. We avoid
// shipping the full `node_modules/` tree (which holds esbuild/typescript/tsx).
//
// Optional deps with native bindings (the @img/sharp-* and @img/sharp-libvips-*
// packages) are picked by sharp at install time per host arch. The deb is
// per-arch too, so whatever npm installed locally is what ships.
//
// We resolve packages by walking `node_modules` directories upward from each
// known package dir. We do not use require.resolve(pkg/package.json) because
// scoped packages with a restrictive `exports` field (e.g. @img/sharp-linux-*)
// reject `./package.json` subpath access.
function findPackageDir(pkgName, fromDir) {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, "node_modules", pkgName);
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function collectRuntimeClosure(rootPkg, rootDir) {
  const queue = [{ name: rootPkg, fromDir: rootDir }];
  const seen = new Map();
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (seen.has(name)) continue;
    const pkgDir = findPackageDir(name, fromDir);
    if (!pkgDir) {
      // Optional deps missing on this host (e.g. wrong-arch @img/* packages)
      // are expected and fine; npm only installs the matching ones.
      continue;
    }
    seen.set(name, pkgDir);
    const pkgJson = await readJson(path.join(pkgDir, "package.json"));
    const deps = {
      ...(pkgJson.dependencies ?? {}),
      ...(pkgJson.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      if (!seen.has(dep)) queue.push({ name: dep, fromDir: pkgDir });
    }
  }
  return seen;
}

const runtimeClosure = await collectRuntimeClosure("sharp", uiDir);
if (!runtimeClosure.has("sharp")) {
  throw new Error(
    "sharp not found in node_modules; run `npm install` in ui/terminal first.",
  );
}

await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorNodeModules, { recursive: true });

for (const [name, pkgDir] of runtimeClosure) {
  const dest = path.join(vendorNodeModules, name);
  await mkdir(path.dirname(dest), { recursive: true });
  // cp -a preserves symlinks (sharp's @img bin layouts use them) and is
  // faster than re-implementing recursive copy in JS.
  const result = spawnSync("cp", ["-a", `${pkgDir}/.`, dest], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to vendor ${name} from ${pkgDir} -> ${dest}`);
  }
}

console.log(
  `\nVendored ${runtimeClosure.size} runtime package(s) to ${path.relative(uiDir, vendorNodeModules)}/`,
);
