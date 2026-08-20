import { readFileSync } from 'node:fs';
import { ProvinceIndex } from '/home/user/hoi4/src/sim/map/ProvinceIndex.ts';
import { createScenario } from '/home/user/hoi4/src/sim/scenario/europe1936.ts';
import { Simulation } from '/home/user/hoi4/src/sim/Simulation.ts';
import { TimeEngine } from '/home/user/hoi4/src/sim/time/TimeEngine.ts';
import { TECHS } from '/home/user/hoi4/src/sim/research/techData.ts';
import { NATIONAL_TREES, GENERIC_TREE } from '/home/user/hoi4/src/sim/focus/focusData.ts';

const index = ProvinceIndex.load(JSON.parse(readFileSync('/home/user/hoi4/public/data/map.json','utf8')));
const seeds = [20250101, 7, 424242, 999, 31337, 2024];
for (const seed of seeds) {
  for (const playerTag of ['ZZZ', 'GER']) {
    const state = createScenario(index, { seed, playerTag });
    const sim = new Simulation(state, index);
    const time = new TimeEngine(state.clock.totalHours);
    time.on(c => sim.tick(c));
    const total = 24 * 365 * 12;
    for (let h = 0; h < total; h++) { time.step(1); if (state.outcome.status !== 'playing') break; }
    const done = new Set<string>();
    for (const c of state.countries) for (const t of c.research.completed ?? []) done.add(t);
    const focusDone = new Set<string>();
    for (const c of state.countries) for (const f of c.focus?.completed ?? []) focusDone.add(f);
    let focusTotal = 0;
    for (const tree of [...NATIONAL_TREES, GENERIC_TREE]) focusTotal += tree.focuses.length;
    const fighters = state.countries.reduce((s,c)=>s+(c.economy.stockpile.fighter??0),0);
    console.log(JSON.stringify({ seed, playerTag,
      end: `${state.clock.year}-${String(state.clock.month).padStart(2,'0')}`,
      day: state.clock.totalDays, outcome: state.outcome.status,
      reason: (state.outcome as any).reason,
      techsDone: done.size, techTotal: TECHS.length,
      techs1942plus: TECHS.filter(t=>t.year>=1942).length,
      done1942plus: TECHS.filter(t=>t.year>=1942 && done.has(t.id)).length,
      focusDone: focusDone.size, focusTotal, fighters,
      combats: state.nextIds.combat,
      divisions: state.nextIds.division }));
  }
}
