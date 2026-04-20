// Stub for `react-devtools-core` so the bundle resolves cleanly.
//
// ink only loads its devtools module when DEV=true is set in the environment
// (see node_modules/ink/build/reconciler.js). We never set that, so this
// default-export shim is never actually invoked at runtime; it only exists
// to satisfy the static `import devtools from 'react-devtools-core'` line in
// ink's devtools.js, which esbuild keeps in the bundle.
export default function reactDevtoolsCoreStub() {
  throw new Error(
    "react-devtools-core was invoked, but the rollio terminal UI bundle does " +
      "not ship it. This indicates DEV=true was set in the environment.",
  );
}
