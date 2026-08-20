import { readFileSync } from 'node:fs';
import { ProvinceIndex } from '/home/user/hoi4/src/sim/map/ProvinceIndex.ts';
import { createScenario } from '/home/user/hoi4/src/sim/scenario/europe1936.ts';
import { Simulation } from '/home/user/hoi4/src/sim/Simulation.ts';
import { TimeEngine } from '/home/user/hoi4/src/sim/time/TimeEngine.ts';
import { EQUIPMENT_TYPES, TERRAIN_TYPES } from '/home/user/hoi4/src/sim/core/types.ts';
import { TECHS } from '/home/user/hoi4/src/sim/research/techData.ts';

const playerTag = process.argv[2] ?? 'ZZZ';
const years = Number(process.argv[3] ?? 12);

const index = ProvinceIndex.load(JSON.parse(readFileSync('/home/user/hoi4/public/data/map.json','utf8')));
const state = createScenario(index, { seed: 20250101, playerTag });
const sim = new Simulation(state, index);
const time = new TimeEngine(state.clock.totalHours);

// ---- accumulators
const factoryDays: Record<string, number> = {};
for (const e of EQUIPMENT_TYPES) factoryDays[e] = 0;
let fortEver = 0; const fortProvinces = new Set<number>();
let supplyMin = 2, supplyLtOne = 0, dayCount = 0;
const combatTerrain: Record<string, number> = {};
for (const t of TERRAIN_TYPES) combatTerrain[t] = 0;
let seenCombats = 0;
const pierceStats = { pierced: 0, blunted: 0 };
let seaCrossingUnits = 0, seaCrossDays = 0;
const armyOrderKinds: Record<string, number> = { none: 0, front: 0, offensive: 0, garrison: 0 };
let planningSum = 0, planningN = 0, planningMax = 0;
let entrenchSum = 0, entrenchN = 0;
const entrenchHist: number[] = [0,0,0,0,0,0,0];
let deficitDays = 0, deficitTot = 0;
const lawHist = new Map<string, number>();
let maxDivExp = 0;
const infraChanged = new Set<number>();
const infraStart = state.states.map(s => s.infrastructure);
const slotsStart = state.states.map(s => s.buildingSlots);
const dockStart = state.states.map(s => s.dockyards);
let dockChanged = 0;
let crMin = 9, crMax = -9;
let supplyLevelLow = 0, supplyLevelN = 0;
let throughputBitten = 0;
const capacityUsed: number[] = [];
let overstack = 0;

const terrainCount: Record<string, number> = {};
for (const p of index.provinces) terrainCount[p.terrain] = (terrainCount[p.terrain] ?? 0) + 1;

time.on(c => {
  sim.tick(c);
  if (!c.newDay) return;
  dayCount++;
  // provinces
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    if (p.supply < supplyMin) supplyMin = p.supply;
    if (p.supply < 0.999) supplyLtOne++;
    if (p.fortLevel > 0) { fortEver++; fortProvinces.add(i); }
  }
  // production
  for (const co of state.countries) {
    for (const l of co.productionLines) factoryDays[l.equipment] += l.assignedFactories;
    for (const r of Object.values(co.economy.resources)) {
      if (r.deficit > 0) { deficitDays++; deficitTot += r.deficit; }
    }
    lawHist.set(co.laws.economy, (lawHist.get(co.laws.economy) ?? 0) + 1);
    lawHist.set('C:' + co.laws.conscription, (lawHist.get('C:' + co.laws.conscription) ?? 0) + 1);
    if (co.economy.consumerGoodsRatio < crMin) crMin = co.economy.consumerGoodsRatio;
    if (co.economy.consumerGoodsRatio > crMax) crMax = co.economy.consumerGoodsRatio;
  }
  // divisions
  for (const d of state.divisions) {
    if (d.dead) continue;
    entrenchSum += d.entrenchment; entrenchN++;
    entrenchHist[Math.min(6, Math.round(d.entrenchment))]++;
    if (d.experience > maxDivExp) maxDivExp = d.experience;
    supplyLevelN++; if (d.supplyLevel < 0.9) supplyLevelLow++;
    if (d.path.length > 0 && index.isSeaLink(d.provinceId, d.path[0])) seaCrossingUnits++;
  }
  // armies
  for (const a of state.armies ?? []) {
    if (a.isArmyGroup) continue;
    armyOrderKinds[a.order?.kind ?? 'none']++;
    planningSum += a.planning; planningN++;
    if (a.planning > planningMax) planningMax = a.planning;
  }
  // combats seen
  for (; seenCombats < state.combats.length; seenCombats++) {
    const cb = state.combats[seenCombats];
    combatTerrain[index.get(cb.province).terrain]++;
  }
  // states changed
  for (let i = 0; i < state.states.length; i++) {
    if (state.states[i].infrastructure !== infraStart[i]) infraChanged.add(i);
    if (state.states[i].dockyards !== dockStart[i]) dockChanged++;
  }
});

const t0 = Date.now();
const totalHours = 24 * 365 * years;
for (let h = 0; h < totalHours; h++) {
  time.step(1);
  if (state.outcome.status !== 'playing') break;
}
const ms = Date.now() - t0;

const out: any = {
  playerTag, days: dayCount, wallMs: ms,
  endDate: `${state.clock.year}-${state.clock.month}-${state.clock.day}`,
  outcome: state.outcome,
  terrainCount,
  factoryDays,
  stockpiles: Object.fromEntries(state.countries.map(c => [c.tag, c.economy.stockpile])),
  supplyMin, supplyLtOneFrac: supplyLtOne / (dayCount * state.provinces.length),
  fortProvinces: fortProvinces.size, fortProvinceDays: fortEver,
  combatTerrain, combatsTotal: state.combats.length,
  seaCrossingUnitDays: seaCrossingUnits,
  armyOrderKinds, planningMean: planningSum / Math.max(1, planningN), planningMax,
  entrenchMean: entrenchSum / Math.max(1, entrenchN), entrenchHist,
  deficitDays, deficitTot,
  maxDivExp,
  infraChangedStates: infraChanged.size, dockChangedDays: dockChanged,
  divSupplyLowFrac: supplyLevelLow / Math.max(1, supplyLevelN),
  consumerRatioMin: crMin, consumerRatioMax: crMax,
  worldTension: state.worldTension,
  wars: state.wars.length,
  capitulated: state.countries.filter(c => c.capitulated).map(c => c.tag),
  divisionsAlive: state.divisions.filter(d => !d.dead).length,
  lawHist: Object.fromEntries([...lawHist].sort((a,b)=>b[1]-a[1])),
  fighterFactoriesByCountry: Object.fromEntries(state.countries.map(c => [c.tag,
    c.productionLines.filter(l=>l.equipment==='fighter').reduce((s,l)=>s+l.assignedFactories,0)])),
  milFactoriesByCountry: Object.fromEntries(state.countries.map(c => [c.tag, c.economy.militaryFactories])),
  dockyardsByCountry: Object.fromEntries(state.countries.map(c => [c.tag, c.economy.dockyards])),
};
// research completion
const techCount = new Map<string, number>();
for (const c of state.countries) for (const t of c.research.completed ?? []) techCount.set(t, (techCount.get(t) ?? 0) + 1);
out.techNeverResearched = TECHS.filter(t => !techCount.has(t.id)).map(t => t.id);
out.techCounts = Object.fromEntries([...techCount].sort((a,b)=>b[1]-a[1]));
out.techTotal = TECHS.length;
// per country templates in use
const tplUse = new Map<string, number>();
for (const d of state.divisions) { if (d.dead) continue; const c = state.countries[d.owner]; const tpl = c.templates.find(t=>t.id===d.templateId); tplUse.set(tpl?.name ?? '?', (tplUse.get(tpl?.name ?? '?') ?? 0)+1); }
out.templateUse = Object.fromEntries(tplUse);
// focus
const focusCount = new Map<string, number>();
for (const c of state.countries) for (const f of c.focus?.completed ?? []) focusCount.set(f, (focusCount.get(f) ?? 0)+1);
out.focusesCompleted = focusCount.size;
out.focusTotalCompletions = [...focusCount.values()].reduce((a,b)=>a+b,0);
console.log(JSON.stringify(out, null, 1));
