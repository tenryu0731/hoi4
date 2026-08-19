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
  }
}

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

async function main(): Promise<void> {
  progress(15, 'Loading theatre map…');
  const res = await fetch(`${import.meta.env.BASE_URL}data/map.json`);
  if (!res.ok) throw new Error(`map.json: HTTP ${res.status}`);
  const mapData = (await res.json()) as MapDataJson;

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

main().catch((err) => {
  console.error(err);
  statusEl.textContent = `Failed to start: ${String(err)}`;
  statusEl.style.color = '#d2453a';
});
