import type {
  BattalionType, BuildingType, CountryId, DivisionId, EquipmentType,
  ProvinceId, StateId, SupportType,
} from './types';

/**
 * Every mutation the player or the AI can request. The presentation layer never
 * touches GameState directly -- it pushes commands, which keeps the simulation
 * replayable and means the AI exercises exactly the same code paths as a human.
 */
export type Command =
  // --- production / economy -------------------------------------------------
  | { t: 'addProductionLine'; country: CountryId; equipment: EquipmentType }
  | { t: 'removeProductionLine'; country: CountryId; line: number }
  | { t: 'setLineFactories'; country: CountryId; line: number; factories: number }
  | { t: 'setLinePriority'; country: CountryId; line: number; priority: 0 | 1 | 2 | 3 }
  | { t: 'queueConstruction'; country: CountryId; kind: BuildingType; state: StateId }
  | { t: 'cancelConstruction'; country: CountryId; item: number }
  | { t: 'reorderConstruction'; country: CountryId; item: number; toIndex: number }
  // --- military -------------------------------------------------------------
  | { t: 'createTemplate'; country: CountryId; name: string; battalions: BattalionType[]; supports: SupportType[] }
  | { t: 'recruitDivision'; country: CountryId; template: number; province: ProvinceId }
  | { t: 'moveDivisions'; divisions: DivisionId[]; target: ProvinceId }
  | { t: 'stopDivisions'; divisions: DivisionId[] }
  | { t: 'setDivisionOrder'; divisions: DivisionId[]; order: 'defend' | 'attack'; target?: ProvinceId }
  // --- diplomacy ------------------------------------------------------------
  | { t: 'justifyWar'; country: CountryId; target: CountryId }
  /**
   * An ultimatum: submit or be invaded. Succeeds or fails on the spot against
   * the strength ratio, so it is a gamble on the target's nerve rather than a
   * negotiation. The AI has always been able to do this; the player must be
   * able to as well, or the two are not playing the same game.
   */
  | { t: 'demandSubmission'; country: CountryId; target: CountryId }
  | { t: 'declareWar'; country: CountryId; target: CountryId }
  | { t: 'guarantee'; country: CountryId; target: CountryId }
  | { t: 'improveRelations'; country: CountryId; target: CountryId }
  | { t: 'inviteToFaction'; country: CountryId; target: CountryId }
  | { t: 'joinFaction'; country: CountryId; faction: number }
  | { t: 'leaveFaction'; country: CountryId }
  // --- research -------------------------------------------------------------
  | { t: 'setResearch'; country: CountryId; branch: 'infantry' | 'armor' | 'air' | 'industry' };

export type CommandType = Command['t'];

/**
 * FIFO queue drained once per hour tick. Commands issued mid-frame therefore
 * always apply at a deterministic point in the schedule.
 */
export class CommandQueue {
  private items: Command[] = [];

  push(cmd: Command): void {
    this.items.push(cmd);
  }

  pushAll(cmds: readonly Command[]): void {
    for (const c of cmds) this.items.push(c);
  }

  get length(): number {
    return this.items.length;
  }

  drain(): Command[] {
    if (this.items.length === 0) return [];
    const out = this.items;
    this.items = [];
    return out;
  }

  clear(): void {
    this.items.length = 0;
  }
}
