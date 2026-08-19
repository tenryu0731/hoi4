import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
