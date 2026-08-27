import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { COMMANDERS } from '../../src/sim/military/commanderData';

/**
 * Fetches a photograph of every commander on the roster.
 *
 * The roster is real men -- Guderian, Zhukov, Rommel -- so the portraits can
 * be too, and the reference's painted officers are themselves painted from
 * these photographs. What this does not do is take the reference's art: that
 * is Paradox's, and shipping it in a public repository would be copying it.
 * These come from Wikimedia Commons under licences that permit redistribution,
 * with the attribution each one requires recorded beside it.
 *
 * The route is Wikidata rather than a text search, because a search for
 * "Model" returns a fashion photograph and the one thing a portrait has to be
 * is the right person. Wikidata's P18 is "image of this subject", attached to
 * the entity the English Wikipedia article is about.
 *
 * Run with `npm run portraits`. Output is committed, so the ordinary asset
 * build stays offline and deterministic.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(__dirname, 'portraits');
const CACHE = join(ROOT, 'tools', '.cache', 'portraits');

/** Wikimedia asks that automated clients identify themselves and a contact. */
const UA = 'iron-front-europe/0.1 (https://github.com/tenryu0731/hoi4) node-fetch';

/**
 * Wikimedia throttles, and it is right to. Run flat out, the first pass got
 * forty-eight portraits and then 429 for the remaining seventy-two. A pause
 * between requests and a backoff on refusal is the price of using somebody
 * else's servers.
 */
const PAUSE_MS = 350;
const RETRIES = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** GET with a pause before it and a backoff after a refusal. */
async function polite(url: string, accept: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await sleep(PAUSE_MS);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept } });
    if (res.ok) return res;
    if ((res.status !== 429 && res.status < 500) || attempt >= RETRIES) {
      throw new Error(`${res.status} ${url}`);
    }
    // Their number if they gave one, ours if they did not.
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1));
  }
}

/**
 * Licences that permit redistribution with attribution.
 *
 * Anything not matching is skipped and reported rather than guessed at. A
 * photograph whose licence cannot be established is not a photograph this can
 * ship, and the fallback silhouette is a perfectly good answer.
 */
const ALLOWED = [
  /^public domain/i, /^pd[- ]/i, /^cc0/i, /^cc by(-sa)?[ -]/i, /^cc[- ]by/i,
];

interface Credit {
  id: string;
  latin: string;
  file: string;
  license: string;
  licenseUrl: string;
  artist: string;
  source: string;
}

const strip = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function api<T>(url: string): Promise<T> {
  const res = await polite(url, 'application/json');
  return res.json() as Promise<T>;
}

interface WdEntities {
  entities?: Record<string, {
    claims?: { P18?: { mainsnak?: { datavalue?: { value?: string } } }[] };
  }>;
}

function firstImage(data: WdEntities): string | null {
  for (const entity of Object.values(data.entities ?? {})) {
    const file = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (file) return file;
  }
  return null;
}

/**
 * The English Wikipedia article about this man, when his name is not its title.
 *
 * Half the British roster is filed under a peerage -- Alan Brooke is "Alan
 * Brooke, 1st Viscount Alanbrooke" -- so an exact-title lookup misses six of
 * the ten. Search finds them, and search will also cheerfully return a
 * fashion photographer for "Model", so the result is only accepted when the
 * title still contains the surname.
 */
async function searchTitle(latin: string): Promise<string | null> {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&list=search'
    + '&srlimit=3&srsearch=' + encodeURIComponent(`${latin} general`);
  const data = await api<{ query?: { search?: { title: string }[] } }>(url);
  const surname = latin.split(' ').pop()?.toLowerCase() ?? '';
  if (surname.length < 3) return null;
  for (const hit of data.query?.search ?? []) {
    if (hit.title.toLowerCase().includes(surname)) return hit.title;
  }
  return null;
}

/** The file name Wikidata says depicts this person, or null. */
async function imageFor(latin: string): Promise<string | null> {
  const byTitle = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json'
    + '&sites=enwiki&props=claims&titles=';
  const exact = firstImage(await api<WdEntities>(byTitle + encodeURIComponent(latin)));
  if (exact) return exact;

  const found = await searchTitle(latin);
  if (!found || found === latin) return null;
  return firstImage(await api<WdEntities>(byTitle + encodeURIComponent(found)));
}

interface FileInfo { license: string; licenseUrl: string; artist: string; source: string }

async function licenseFor(file: string): Promise<FileInfo | null> {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&prop=imageinfo&iiprop=extmetadata&titles=' + encodeURIComponent(`File:${file}`);
  const data = await api<{ query?: { pages?: Record<string, {
    imageinfo?: { extmetadata?: Record<string, { value?: string }> }[];
  }> } }>(url);
  for (const page of Object.values(data.query?.pages ?? {})) {
    const md = page.imageinfo?.[0]?.extmetadata;
    if (!md) continue;
    return {
      license: strip(md.LicenseShortName?.value ?? ''),
      licenseUrl: strip(md.LicenseUrl?.value ?? ''),
      artist: strip(md.Artist?.value ?? '').slice(0, 120),
      source: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    };
  }
  return null;
}

async function download(file: string): Promise<Buffer> {
  const cached = join(CACHE, file.replace(/[^\w.-]/g, '_'));
  if (existsSync(cached)) return readFile(cached);
  // Special:FilePath negotiates a size that actually exists: an arbitrary
  // width against the thumbnail host is refused outright now.
  const url = 'https://commons.wikimedia.org/wiki/Special:FilePath/'
    + encodeURIComponent(file) + '?width=400';
  const res = await polite(url, 'image/*');
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, buf);
  return buf;
}

/**
 * One photograph, cut down to the plate it is shown in.
 *
 * Cropped from the top rather than the centre, because these are portrait
 * photographs and the head is at the top of one; centred, half of them come
 * out as a tunic. Monochrome and normalised so that a hundred and twenty
 * photographs from a hundred and twenty sources -- some sepia, some blown
 * out, some nearly black -- read as one set rather than as a scrapbook.
 */
async function plate(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize(72, 88, { fit: 'cover', position: 'north' })
    .grayscale()
    .normalise()
    .webp({ quality: 62 })
    .toBuffer();
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const credits: Credit[] = [];
  const skipped: string[] = [];

  // A re-run fills the gaps rather than starting again: the first pass is the
  // one that gets throttled, and re-fetching what already landed would only
  // spend somebody else's bandwidth to arrive at the same file.
  const existing = new Map<string, Credit>();
  const creditsPath = join(OUT, 'credits.json');
  if (existsSync(creditsPath)) {
    for (const c of JSON.parse(await readFile(creditsPath, 'utf8')) as Credit[]) {
      existing.set(c.id, c);
    }
  }

  for (const c of COMMANDERS) {
    const done = existing.get(c.id);
    if (done && existsSync(join(OUT, `${c.id}.webp`))) { credits.push(done); continue; }
    try {
      const file = await imageFor(c.latin);
      if (!file) { skipped.push(`${c.id}: no image on Wikidata`); continue; }
      const info = await licenseFor(file);
      if (!info) { skipped.push(`${c.id}: no licence metadata`); continue; }
      if (!ALLOWED.some((re) => re.test(info.license))) {
        skipped.push(`${c.id}: licence "${info.license}"`);
        continue;
      }
      const out = await plate(await download(file));
      await writeFile(join(OUT, `${c.id}.webp`), out);
      credits.push({ id: c.id, latin: c.latin, file, ...info });
      process.stdout.write(`${c.id} ${out.length}B ${info.license}\n`);
    } catch (e) {
      skipped.push(`${c.id}: ${String(e)}`);
    }
  }

  credits.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(OUT, 'credits.json'), `${JSON.stringify(credits, null, 2)}\n`);

  // The human-readable half. Several of these licences require attribution
  // wherever the work is used, and a JSON file inside the build tooling is
  // not where anybody would look for it.
  const doc = [
    '# 将校肖像の出典',
    '',
    'ゲーム内の将校肖像は Wikimedia Commons の写真を縮小・単色化したものです。',
    '**Paradox の HOI4 の肖像画は使っていません**——あれは同社の著作物で、',
    '公開リポジトリに同梱すれば複製にあたります。ここにあるのは同じ人物を',
    '写した、再配布を許諾する条件の写真です。',
    '',
    '取得は `npm run portraits`（`tools/asset-gen/fetch-portraits.ts`）。',
    'Wikidata の P18「この主題の画像」を辿るので、同名の別人を掴むことがありません。',
    '',
    `${credits.length} 点。`,
    '',
    '| 指揮官 | ファイル | ライセンス | 作者 |',
    '| --- | --- | --- | --- |',
    ...credits.map((c) => {
      const link = `[${c.file.replace(/\|/g, '/')}](${c.source})`;
      const lic = c.licenseUrl ? `[${c.license}](${c.licenseUrl})` : c.license;
      return `| ${c.latin} | ${link} | ${lic} | ${c.artist.replace(/\|/g, '/') || '不明'} |`;
    }),
    '',
  ].join('\n');
  await writeFile(join(ROOT, 'docs', 'portrait-credits.md'), doc);

  console.log(`\n${credits.length} portraits, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  - ${s}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
