import { Game } from './app/Game';
import type { MapDataJson } from './sim/map/MapData';

/**
 * Browser entry point. Everything testable lives in Game; this file only deals
 * with the DOM shell, the boot sequence, and the hooks the e2e suite drives.
 */

declare global {
  interface Window {
    __game?: Game;
    __gameReady?: boolean;
    /** Set the instant this module runs, so the boot guard can tell a slow
     *  load apart from a bundle that never executed at all. */
    __bootStarted?: boolean;
    __bootFail?: (title: string, detail?: string) => void;
    /** Present only in the single-file build, which has no server to fetch from. */
    __INLINE_MAP__?: MapDataJson;
  }
}

window.__bootStarted = true;

const params = new URLSearchParams(location.search);
const staticMode = params.get('static') === '1';
const playerTag = params.get('country') ?? 'GER';
const seed = Number(params.get('seed') ?? '20250101');

const bootEl = document.getElementById('boot')!;
const fillEl = document.getElementById('boot-fill')!;
const statusEl = document.getElementById('boot-status')!;

function progress(pct: number, label: string): void {
  fillEl.style.width = `${pct}%`;
  statusEl.textContent = label;
}

/**
 * The map is the one thing the game cannot start without, and the one request
 * most likely to fail on someone else's hosting, so it reports precisely which
 * URL it asked for.
 */
async function loadMapData(): Promise<MapDataJson> {
  const url = `${import.meta.env.BASE_URL}data/map.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not reach ${url} (${String(err)})`);
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as MapDataJson;
}

async function main(): Promise<void> {
  progress(15, 'Loading theatre map…');
  const mapData = window.__INLINE_MAP__ ?? (await loadMapData());

  progress(55, 'Deploying forces…');
  const game = await Game.create({
    canvasParent: document.getElementById('map-root')!,
    mapData,
    seed,
    playerTag,
    staticMode,
  });

  progress(85, 'Preparing headquarters…');
  const { mountHud } = await import('./ui/Hud');
  mountHud(game, document.getElementById('hud')!);

  window.__game = game;
  game.start();
  if (!staticMode) game.setSpeed(2);

  progress(100, 'Ready');
  requestAnimationFrame(() => {
    bootEl.classList.add('done');
    window.__gameReady = true;
  });

  const root = document.getElementById('map-root')!;
  const onResize = () => game.resize(root.clientWidth, root.clientHeight);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  // A ResizeObserver also catches the mobile URL bar collapsing, which does not
  // always fire a window resize event.
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(root);
  onResize();
}

main().catch((err: unknown) => {
  console.error(err);
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (window.__bootFail) window.__bootFail('Failed to start.', detail);
  else {
    statusEl.textContent = `Failed to start: ${detail}`;
    statusEl.style.color = '#d2453a';
  }
});
