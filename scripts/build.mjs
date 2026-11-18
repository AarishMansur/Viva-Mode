
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

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(out, 'preload.cjs'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
});

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
