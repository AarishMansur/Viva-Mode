// scripts/build.mjs
// Bundles the three Electron entry points and copies static renderer assets.
//
//   main     -> dist/main.cjs      (CJS, node_modules external, electron external)
//   preload  -> dist/preload.cjs   (CJS, SDK preload bundled in — sandboxed
//                                   preloads cannot require node_modules)
//   renderer -> dist/renderer.js   (IIFE, browser bundle: SDK renderer +
//                                   protobuf decoder + Chart.js)
//
// Run with `npm run build`.

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// --- main process -----------------------------------------------------------
// Everything in node_modules stays external: @smartspectra/node-sdk/main
// resolves the native runtime relative to its own package directory, and
// koffi must load its prebuilt binary from disk.
await build({
  ...shared,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
});

// --- preload ---------------------------------------------------------------
// The SDK preload is pure JS (only requires `electron`), so it folds into our
// bundle cleanly. `electron` itself must stay external.
await build({
  ...shared,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(out, 'preload.cjs'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
});

// --- renderer --------------------------------------------------------------
await build({
  ...shared,
  entryPoints: [path.join(root, 'src/renderer/renderer.ts')],
  outfile: path.join(out, 'renderer.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
});

await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));
await cp(path.join(root, 'src/renderer/styles.css'), path.join(out, 'styles.css'));

console.log('[build] dist/ ready');
