import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { build } from 'vite';

/**
 * Packs the whole game into one HTML file that runs from `file://`.
 *
 * The normal build needs a web server: ES modules, `fetch` for the map, and
 * separate asset requests are all blocked or useless on a local file. A phone
 * is rarely the machine running a dev server, so this build exists purely so
 * the game can be handed over as a single downloadable file -- classic script,
 * no imports, map and artwork embedded.
 */

const ROOT = process.cwd();
// Written to the repository root, not to dist/, because its whole purpose is
// to be served or handed over as-is: GitHub Pages publishing a branch serves
// the repository, so this is the one file there that actually runs.
const OUT_FILE = join(ROOT, 'play.html');
const STAGE = join(ROOT, 'dist-single', '.stage');

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** JS string literal, safe to drop inside a <script> block. */
function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function main(): Promise<void> {
  mkdirSync(STAGE, { recursive: true });

  // Library mode gives us exactly what a file:// page can run: one IIFE with
  // the dynamic import folded in, and one stylesheet.
  await build({
    // Not the project config: its manual pixi chunk is incompatible with the
    // single-bundle output, and merging cannot remove it.
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    resolve: { alias: { '@': join(ROOT, 'src') } },
    build: {
      outDir: STAGE,
      emptyOutDir: true,
      target: 'es2022',
      cssCodeSplit: false,
      lib: { entry: join(ROOT, 'src/main.ts'), formats: ['iife'], name: 'IronFront', fileName: () => 'app.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });

  const script = readFileSync(join(STAGE, 'app.js'), 'utf8');
  const staged = readdirSync(STAGE);
  const cssName = staged.find((f) => f.endsWith('.css'));
  const css = [
    readFileSync(join(ROOT, 'src/style.css'), 'utf8'),
    cssName ? readFileSync(join(STAGE, cssName), 'utf8') : '',
  ].join('\n');

  const assetDir = join(ROOT, 'public/assets');
  const assets: Record<string, string> = {};
  for (const file of walk(assetDir)) {
    const key = relative(assetDir, file).split('\\').join('/');
    const mime = MIME[extname(file)] ?? 'application/octet-stream';
    assets[key] = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  }
  const mapJson = readFileSync(join(ROOT, 'public/data/map.json'), 'utf8');

  const favicon = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'public/favicon.svg')).toString('base64')}`;

  // Substituted through a function, never a replacement string: minified code
  // and base64 both contain `$&` and `$'`, which String.replace would expand
  // into fragments of the surrounding HTML.
  const sub = (input: string, find: string, value: string): string => {
    if (!input.includes(find)) throw new Error(`index.html no longer contains ${find}`);
    return input.replace(find, () => value);
  };

  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  html = sub(html, '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />',
    `<link rel="icon" type="image/svg+xml" href="${favicon}" />`);
  html = sub(html, '<link rel="stylesheet" href="./src/style.css" />', `<style>\n${css}\n</style>`);
  html = sub(html, '<script type="module" src="./src/main.ts"></script>',
    '<script>\n' +
    `window.__INLINE_MAP__ = JSON.parse(${jsString(mapJson)});\n` +
    `window.__INLINE_ASSETS__ = JSON.parse(${jsString(JSON.stringify(assets))});\n` +
    '</script>\n' +
    `<script>\n${script}\n</script>`);

  writeFileSync(OUT_FILE, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`single-file build: ${relative(ROOT, OUT_FILE)} (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
