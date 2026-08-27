import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERRAIN_COLOR } from '../../src/render/palette';

/**
 * Architectural invariants, enforced as tests.
 *
 * ARCHITECTURE.md states that the simulation is DOM-free and deterministic.
 * Those are not stylistic preferences: they are what let the whole campaign run
 * headless in seconds, what makes the invariant checks possible, and what makes
 * a screenshot diff meaningful. A rule nothing enforces is a rule that erodes.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strips comments and string literals so matches are real code. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('architecture', () => {
  const simFiles = walk(join(SRC, 'sim'));

  it('has a simulation layer to check', () => {
    expect(simFiles.length).toBeGreaterThan(10);
  });

  it('keeps the simulation free of browser globals', () => {
    const banned = [
      /\bdocument\s*\./, /\bwindow\s*\./, /\bnavigator\s*\./,
      /\blocalStorage\b/, /\bperformance\s*\./, /\brequestAnimationFrame\b/,
      /\bHTMLElement\b/, /\bCanvasRenderingContext2D\b/,
    ];
    const offenders: string[] = [];
    for (const file of simFiles) {
      const body = code(readFileSync(file, 'utf8'));
      for (const rx of banned) {
        if (rx.test(body)) offenders.push(`${file}: ${rx}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the simulation free of nondeterminism', () => {
    const banned = [/Math\s*\.\s*random/, /\bDate\s*\.\s*now\b/, /\bnew\s+Date\b/];
    const offenders: string[] = [];
    for (const file of simFiles) {
      const body = code(readFileSync(file, 'utf8'));
      for (const rx of banned) {
        if (rx.test(body)) offenders.push(`${file}: ${rx}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never imports rendering, input or UI from the simulation', () => {
    const offenders: string[] = [];
    for (const file of simFiles) {
      const body = readFileSync(file, 'utf8');
      for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
        const target = m[1];
        if (/\/(render|input|ui|app)\//.test(target) || /^\.\.\/(render|input|ui|app)/.test(target)) {
          offenders.push(`${file} imports ${target}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never imports pixi from the simulation', () => {
    const offenders = simFiles.filter((f) => /from\s+'pixi\.js'/.test(readFileSync(f, 'utf8')));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('routes every state mutation from the presentation layer through commands', () => {
    // The renderer, input and UI layers may read GameState but must not write
    // to it; anything they want changed goes through the command queue.
    const uiFiles = [
      ...walk(join(SRC, 'ui')),
      ...walk(join(SRC, 'input')),
      ...walk(join(SRC, 'render')),
    ];
    const offenders: string[] = [];
    for (const file of uiFiles) {
      const body = code(readFileSync(file, 'utf8'));
      // Assignments into a `state.` path are the mutation shape we care about.
      if (/\bstate\s*\.\s*\w+[\w.[\]]*\s*=[^=]/.test(body)) offenders.push(file);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * Every command has something that sends it.
 *
 * This has now been the same bug three times: a command written into the bus
 * with the subsystem, correct and tested, and no button anywhere that could
 * reach it. Eight of them were dead at the last count and five of those were
 * the whole non-belligerent half of diplomacy -- so the game had guarantees
 * and factions in the simulation and a diplomacy panel that could only start
 * a war. A feature nothing can invoke is a feature that does not exist, and
 * it looks exactly like a finished one from inside the source.
 */
describe('the command bus', () => {
  const COMMANDS = join(SRC, 'sim', 'core', 'commands.ts');
  const BUS = join(SRC, 'sim', 'Simulation.ts');

  // The union is written one variant per line as `| { t: 'name'; ... }`. Read
  // from the raw source rather than through `code()`, which blanks exactly the
  // string literals the names live in.
  const commandNames = (): string[] => [...new Set(
    [...readFileSync(COMMANDS, 'utf8').matchAll(/\|\s*\{\s*t:\s*'([a-zA-Z]+)'/g)]
      .map((m) => m[1]),
  )];

  it('names enough commands to be worth checking', () => {
    expect(commandNames().length).toBeGreaterThan(20);
  });

  it('has a caller for every command it accepts', () => {
    const senders = walk(SRC)
      .filter((f) => f !== COMMANDS && f !== BUS)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const dead = commandNames().filter((n) => !senders.includes(`t: '${n}'`));
    expect(dead, `no caller sends: ${dead.join(', ')}`).toEqual([]);
  });

  it('handles every command it accepts', () => {
    const bus = readFileSync(BUS, 'utf8');
    const unhandled = commandNames().filter((n) => !bus.includes(`case '${n}':`));
    expect(unhandled, `no case in the bus for: ${unhandled.join(', ')}`).toEqual([]);
  });
});

/**
 * Terrain colours must stay separable.
 *
 * The map mode is a legend, not a landscape: seven categories that share a
 * colour are seven categories the player cannot read. CIE dE76 25 is roughly
 * the point at which two fills stay distinguishable in a small patch at phone
 * scale, and the set this replaced had eleven of twenty-one pairs below it.
 */
describe('terrain palette', () => {
  const toLab = (hex: number): [number, number, number] => {
    const lin = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
    const r = lin(((hex >> 16) & 0xff) / 255);
    const g = lin(((hex >> 8) & 0xff) / 255);
    const b = lin((hex & 0xff) / 255);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };

  it('keeps every pair of terrain fills at least dE 25 apart', () => {
    const entries = Object.entries(TERRAIN_COLOR);
    const tooClose: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = toLab(entries[i][1]);
        const b = toLab(entries[j][1]);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (d < 25) tooClose.push(`${entries[i][0]}/${entries[j][0]} dE ${d.toFixed(1)}`);
      }
    }
    expect(tooClose, tooClose.join(', ')).toEqual([]);
  });
});
