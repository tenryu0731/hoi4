import { readFileSync } from 'node:fs';
import { ProvinceIndex } from '/home/user/hoi4/src/sim/map/ProvinceIndex.ts';
import { createScenario } from '/home/user/hoi4/src/sim/scenario/europe1936.ts';
import { Simulation } from '/home/user/hoi4/src/sim/Simulation.ts';
import { TimeEngine } from '/home/user/hoi4/src/sim/time/TimeEngine.ts';
import { TERRAIN } from '/home/user/hoi4/src/sim/core/data.ts';
import { effectiveTemplate } from '/home/user/hoi4/src/sim/research/index.ts';
import { winterSeverity } from '/home/user/hoi4/src/sim/military/weather.ts';

const playerTag = process.argv[2] ?? 'ZZZ';
const seed = Number(process.argv[3] ?? 20250101);
const index = ProvinceIndex.load(JSON.parse(readFileSync('/home/user/hoi4/public/data/map.json','utf8')));
const state = createScenario(index, { seed, playerTag });
const sim = new Simulation(state, index);
const time = new TimeEngine(state.clock.totalHours);

const tplOf = (d: any) => state.countries[d.owner].templates.find((t: any) => t.id === d.templateId);

interface Rec { id: number; prov: number; terrain: string; fort: number; winter: number;
  maxAtt: number; maxDef: number; widthAtt: number; widthDef: number; width: number;
  hours: number; attArmor: number; attPierce: number; defArmor: number; defPierce: number; ended: boolean }
const recs = new Map<number, Rec>();
let crossings = 0; let captures = 0; let capturesWithBattle = 0;
const prevProv = new Map<number, number>();
const prevCtl = state.provinces.map(p => p.controller);
let winterDivHours = 0, winterDivHoursSevere = 0;
let widthBoundRounds = 0, totalRounds = 0;
let piercedRounds = 0, bluntedRounds = 0;

time.on(c => {
  sim.tick(c);
  // sea crossings
  for (const d of state.divisions) {
    if (d.dead) continue;
    const prev = prevProv.get(d.id);
    if (prev !== undefined && prev !== d.provinceId && index.isSeaLink(prev, d.provinceId)) crossings++;
    prevProv.set(d.id, d.provinceId);
  }
  // captures
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== prevCtl[i]) {
      captures++;
      prevCtl[i] = state.provinces[i].controller;
      if (state.combats.some(cb => cb.province === i)) capturesWithBattle++;
    }
  }
  // combats
  for (const cb of state.combats) {
    let r = recs.get(cb.id);
    if (!r) {
      const geo = index.get(cb.province);
      r = { id: cb.id, prov: cb.province, terrain: geo.terrain, fort: state.provinces[cb.province].fortLevel,
        winter: winterSeverity(state, index, cb.province),
        maxAtt: 0, maxDef: 0, widthAtt: 0, widthDef: 0, width: TERRAIN[geo.terrain].combatWidth,
        hours: 0, attArmor: 0, attPierce: 0, defArmor: 0, defPierce: 0, ended: false };
      recs.set(cb.id, r);
    }
    if (r.ended) continue;
    if (cb.ended) { r.ended = true; continue; }
    r.hours++;
    totalRounds++;
    let wa = 0, wd = 0, aA = 0, aP = 0, dA = 0, dP = 0;
    for (const id of cb.attackers) { const d = state.divisions[id]; if (!d || d.dead) continue;
      const t = effectiveTemplate(state, d.owner, tplOf(d)); wa += t.width; aA = Math.max(aA, t.armor); aP = Math.max(aP, t.piercing); }
    for (const id of cb.defenders) { const d = state.divisions[id]; if (!d || d.dead) continue;
      const t = effectiveTemplate(state, d.owner, tplOf(d)); wd += t.width; dA = Math.max(dA, t.armor); dP = Math.max(dP, t.piercing); }
    r.maxAtt = Math.max(r.maxAtt, cb.attackers.length); r.maxDef = Math.max(r.maxDef, cb.defenders.length);
    r.widthAtt = Math.max(r.widthAtt, wa); r.widthDef = Math.max(r.widthDef, wd);
    r.attArmor = Math.max(r.attArmor, aA); r.attPierce = Math.max(r.attPierce, aP);
    r.defArmor = Math.max(r.defArmor, dA); r.defPierce = Math.max(r.defPierce, dP);
    if (wa > r.width || wd > r.width) widthBoundRounds++;
    if (aP >= dA) piercedRounds++; else bluntedRounds++;
    if (dP >= aA) piercedRounds++; else bluntedRounds++;
  }
  if (c.newDay) {
    for (const d of state.divisions) { if (d.dead) continue;
      const w = winterSeverity(state, index, d.provinceId);
      if (w > 0) { winterDivHours++; if (w > 0.4) winterDivHoursSevere++; } }
  }
});

const total = 24 * 365 * 12;
for (let h = 0; h < total; h++) { time.step(1); if (state.outcome.status !== 'playing') break; }

const arr = [...recs.values()];
const sum = (f: (r: Rec)=>number) => arr.reduce((s,r)=>s+f(r),0);
console.log(JSON.stringify({
  seed, playerTag,
  endDate: `${state.clock.year}-${state.clock.month}-${state.clock.day}`,
  outcome: state.outcome,
  totalCombatsEver: state.nextIds.combat,
  recorded: arr.length,
  captures, capturesWithBattle,
  crossings,
  meanCombatHours: sum(r=>r.hours)/Math.max(1,arr.length),
  maxCombatHours: Math.max(0,...arr.map(r=>r.hours)),
  combatsWithFort: arr.filter(r=>r.fort>0).length,
  combatsInWinter: arr.filter(r=>r.winter>0).length,
  terrainHist: arr.reduce((m:any,r)=>{m[r.terrain]=(m[r.terrain]??0)+1;return m;},{}),
  widthBoundRounds, totalRounds,
  maxWidthAtt: Math.max(0,...arr.map(r=>r.widthAtt)), maxWidthDef: Math.max(0,...arr.map(r=>r.widthDef)),
  widthOverflowCombats: arr.filter(r=>r.widthAtt>r.width||r.widthDef>r.width).length,
  maxAttackers: Math.max(0,...arr.map(r=>r.maxAtt)), maxDefenders: Math.max(0,...arr.map(r=>r.maxDef)),
  piercedRounds, bluntedRounds,
  armorPairs: [...new Set(arr.map(r=>`att a${r.attArmor}/p${r.attPierce} vs def a${r.defArmor}/p${r.defPierce}`))].slice(0,20),
  winterDivDays: winterDivHours, winterDivDaysSevere: winterDivHoursSevere,
  totalFighters: state.countries.reduce((s,c)=>s+(c.economy.stockpile.fighter??0),0),
  totalCas: state.countries.reduce((s,c)=>s+(c.economy.stockpile.cas??0),0),
  totalConvoy: state.countries.reduce((s,c)=>s+(c.economy.stockpile.convoy??0),0),
  divisionsAlive: state.divisions.filter(d=>!d.dead).length,
  divisionsEverMade: state.nextIds.division,
}, null, 1));
