import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('ui/card.js', root))],
  bundle: true, format: 'esm', write: false, minify: true, target: 'es2022' });
const reference = await readFile(new URL('ui/assets/placeholder.png', root));
const logo = await readFile(new URL('ui/assets/lovart-logo.svg', root));
const template = (await readFile(new URL('ui/card.html', root), 'utf8'))
  .replace('/* REFERENCE_IMAGE */', `data:image/png;base64,${reference.toString('base64')}`)
  .replace('/* LOVART_LOGO */', `data:image/svg+xml;base64,${logo.toString('base64')}`);
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/card.html', root), template.replace('/* BUNDLE */', () => script).replace('<script>', '<script type="module">').trimEnd()+'\n');
await build({ entryPoints: [fileURLToPath(new URL('src/index.js', root))],
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  outfile: fileURLToPath(new URL('dist/server.mjs', root)) });
