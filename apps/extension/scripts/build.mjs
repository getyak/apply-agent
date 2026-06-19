// Bundle MV3 extension: content / background / popup with esbuild,
// then copy manifest + popup.html into dist/.
//
// Caller: apps/extension/package.json `build` script.
//         CI .github/workflows/ci.yml extension job `bun run build`.
//
// Why hand-rolled: WXT / Plasmo are nice but each pull >100MB of deps. We
// have 3 source files; esbuild + a tiny copy step is enough and keeps the
// extension CI job under 30 seconds.

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DIST = resolve(ROOT, 'dist');

async function main() {
  if (existsSync(DIST)) await rm(DIST, { recursive: true });
  await mkdir(DIST, { recursive: true });

  await build({
    entryPoints: {
      content: resolve(SRC, 'content.ts'),
      background: resolve(SRC, 'background.ts'),
      popup: resolve(SRC, 'popup.ts'),
    },
    bundle: true,
    outdir: DIST,
    format: 'esm',
    target: 'chrome120',
    sourcemap: 'inline',
    minify: false,
    legalComments: 'none',
    define: {
      __EXTENSION_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-dev'),
    },
  });

  // Manifest + popup.html copy
  await cp(resolve(ROOT, 'manifest.json'), resolve(DIST, 'manifest.json'));
  await cp(resolve(SRC, 'popup.html'), resolve(DIST, 'popup.html'));

  // Generate a single-color SVG icon at build time so we don't ship binary
  // PNGs in the repo. Chrome accepts SVG action icons starting with M111.
  const iconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
    '<rect width="128" height="128" rx="22" fill="#0F172A"/>' +
    '<path d="M40 36h12l12 38 12-38h12L72 96H56z" fill="#FACC15"/>' +
    '</svg>';
  await writeFile(resolve(DIST, 'icon.svg'), iconSvg);

  console.log('built ->', DIST);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
