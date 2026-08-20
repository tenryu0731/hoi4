import type { GameState } from './types';
import { effectiveTemplate } from '../research';

/**
 * Structural checks asserted during headless scenario runs. A violation means
 * the simulation has corrupted itself, which is far more useful to catch at the
 * moment it happens than to debug from a wrong-looking end state.
 */
export function checkInvariants(state: GameState, provinceCount: number): string[] {
  const errors: string[] = [];
  const push = (m: string) => {
    if (errors.length < 20) errors.push(m);
  };

  if (state.provinces.length !== provinceCount) {
    push(`province array length ${state.provinces.length} != ${provinceCount}`);
  }

  const liveCombats = new Set<number>();
  for (const c of state.combats) if (!c.ended) liveCombats.add(c.id);

  for (const d of state.divisions) {
    if (d.dead) continue;
    if (!Number.isInteger(d.provinceId) || d.provinceId < 0 || d.provinceId >= provinceCount) {
      push(`division ${d.id} on invalid province ${d.provinceId}`);
      continue;
    }
    const base = state.countries[d.owner]?.templates.find((t) => t.id === d.templateId);
    if (!base) {
      push(`division ${d.id} references missing template ${d.templateId}`);
      continue;
    }
    // Against the effective template, not the base one: technology raises the
    // organisation and strength ceilings, and a division sitting at its real
    // maximum is not a violation just because the printed template is older.
    const tpl = effectiveTemplate(state, d.owner, base);
    if (!(d.org >= -1e-6) || d.org > tpl.maxOrg + 1e-6) {
      push(`division ${d.id} org ${d.org} out of [0, ${tpl.maxOrg}]`);
    }
    if (!(d.hp >= -1e-6) || d.hp > tpl.maxHp + 1e-6) {
      push(`division ${d.id} hp ${d.hp} out of [0, ${tpl.maxHp}]`);
    }
    if (!Number.isFinite(d.org) || !Number.isFinite(d.hp)) {
      push(`division ${d.id} has non-finite org/hp`);
    }
    if (d.combatId !== null && !liveCombats.has(d.combatId)) {
      push(`division ${d.id} points at stale combat ${d.combatId}`);
    }
  }

  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    if (!state.countries[p.owner]) push(`province ${i} owned by unknown country ${p.owner}`);
    if (!state.countries[p.controller]) push(`province ${i} controlled by unknown ${p.controller}`);
    if (state.countries[p.controller]?.capitulated) {
      push(`province ${i} controlled by capitulated country ${p.controller}`);
    }
  }

  for (const c of state.countries) {
    const e = c.economy;
    if (e.manpower < -1e-6) push(`${c.tag} negative manpower ${e.manpower}`);
    if (e.politicalPower < -1e-6) push(`${c.tag} negative political power`);
    for (const k of Object.keys(e.stockpile) as (keyof typeof e.stockpile)[]) {
      const v = e.stockpile[k];
      if (!(v >= -1e-6) || !Number.isFinite(v)) push(`${c.tag} bad stockpile ${String(k)}=${v}`);
    }
    for (const line of c.productionLines) {
      if (line.assignedFactories < 0) push(`${c.tag} line ${line.id} negative factories`);
      if (line.efficiency < 0 || line.efficiency > 1.5) {
        push(`${c.tag} line ${line.id} efficiency ${line.efficiency} out of range`);
      }
    }
    const assigned = c.productionLines.reduce((s, l) => s + l.assignedFactories, 0);
    if (assigned > e.militaryFactories + 1e-6) {
      push(`${c.tag} assigned ${assigned} factories > ${e.militaryFactories} available`);
    }
  }

  return errors;
}
