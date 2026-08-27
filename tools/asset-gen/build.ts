import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { FLAGS, renderFlag } from './flags';
import {
  EQUIPMENT_ICONS, PORTRAIT_ICONS, RESOURCE_ICONS, UI_ICONS, UNIT_ICONS,
} from './icons';

/**
 * Writes the generated asset set and a manifest describing it.
 *
 * The manifest is what the load-time test asserts against: total size, per-file
 * size, and the expected inventory. An asset budget that is not measured is not
 * a budget.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'public', 'assets');

interface AssetEntry {
  path: string;
  bytes: number;
  gzipBytes: number;
}

async function writeAsset(
  rel: string, contents: string, entries: AssetEntry[],
): Promise<void> {
  const full = join(OUT, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
  entries.push({
    path: `assets/${rel}`,
    bytes: Buffer.byteLength(contents, 'utf8'),
    gzipBytes: gzipSync(Buffer.from(contents, 'utf8')).length,
  });
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  const entries: AssetEntry[] = [];

  for (const [tag, spec] of Object.entries(FLAGS)) {
    await writeAsset(`flags/${tag}.svg`, renderFlag(spec), entries);
  }
  for (const [name, body] of Object.entries(RESOURCE_ICONS)) {
    await writeAsset(`icons/resource-${name}.svg`, body, entries);
  }
  for (const [name, body] of Object.entries(UI_ICONS)) {
    await writeAsset(`icons/ui-${name}.svg`, body, entries);
  }
  for (const [name, body] of Object.entries(EQUIPMENT_ICONS)) {
    await writeAsset(`icons/equipment-${name}.svg`, body, entries);
  }
  for (const [name, body] of Object.entries(UNIT_ICONS)) {
    await writeAsset(`units/${name}.svg`, body, entries);
  }
  for (const [name, body] of Object.entries(PORTRAIT_ICONS)) {
    await writeAsset(`portraits/${name}.svg`, body, entries);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const totalGzip = entries.reduce((s, e) => s + e.gzipBytes, 0);

  const manifest = {
    generated: 'tools/asset-gen/build.ts',
    counts: {
      flags: Object.keys(FLAGS).length,
      resourceIcons: Object.keys(RESOURCE_ICONS).length,
      uiIcons: Object.keys(UI_ICONS).length,
      equipmentIcons: Object.keys(EQUIPMENT_ICONS).length,
      unitIcons: Object.keys(UNIT_ICONS).length,
      portraits: Object.keys(PORTRAIT_ICONS).length,
    },
    totalBytes,
    totalGzipBytes: totalGzip,
    assets: entries,
  };
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `assets: ${entries.length} files, ${(totalBytes / 1024).toFixed(1)} KB ` +
    `(${(totalGzip / 1024).toFixed(1)} KB gzipped)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
