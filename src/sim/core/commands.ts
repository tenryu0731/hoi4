import type {
  ArmyId, ArmyOrder, BattalionType, BuildingType, CommanderId, CountryId, DivisionId,
  EquipmentType, ProvinceId, ResourceType, StateId, SupportType, TechId, VariantModule,
} from './types';
import type { LawKind } from '../politics/politics';

/**
 * Every mutation the player or the AI can request. The presentation layer never
 * touches GameState directly -- it pushes commands, which keeps the simulation
 * replayable and means the AI exercises exactly the same code paths as a human.
 */
export type Command =
  | { t: 'changeLaw'; country: CountryId; kind: LawKind; step: 1 | -1 }
  /** Commits civilian factories to buying a resource abroad; see sim/economy/trade. */
  | {
      t: 'openTrade'; country: CountryId; seller: CountryId;
      resource: ResourceType; factories: number;
    }
  | {
      t: 'closeTrade'; country: CountryId; seller: CountryId;
      resource: ResourceType; factories: number;
    }
  // --- production / economy -------------------------------------------------
  | { t: 'addProductionLine'; country: CountryId; equipment: EquipmentType }
  | { t: 'removeProductionLine'; country: CountryId; line: number }
  | { t: 'setLineFactories'; country: CountryId; line: number; factories: number }
  | { t: 'setLinePriority'; country: CountryId; line: number; priority: 0 | 1 | 2 | 3 }
  /**
   * Raises or lowers one module of one equipment type's mark. Stepping up
   * costs army experience, which is only earned in combat; stepping down is
   * free and refunds nothing.
   */
  | {
      t: 'upgradeVariant'; country: CountryId; equipment: EquipmentType;
      module: VariantModule; step: 1 | -1;
    }
  | { t: 'queueConstruction'; country: CountryId; kind: BuildingType; state: StateId }
  | { t: 'cancelConstruction'; country: CountryId; item: number }
  | { t: 'reorderConstruction'; country: CountryId; item: number; toIndex: number }
  // --- military -------------------------------------------------------------
  | { t: 'createTemplate'; country: CountryId; name: string; battalions: BattalionType[]; supports: SupportType[] }
  | { t: 'recruitDivision'; country: CountryId; template: number; province: ProvinceId }
  | { t: 'moveDivisions'; divisions: DivisionId[]; target: ProvinceId }
  | { t: 'stopDivisions'; divisions: DivisionId[] }
  /*
   * There was a setDivisionOrder here, and it is gone: nothing in the game
   * ever sent it, and both of its branches were something else wearing a
   * different name. 'defend' did exactly what stopDivisions does, and
   * 'attack' did exactly what moveDivisions does -- so it was a third way to
   * spell two commands that already existed, and the one of the three that no
   * button reached.
   */
  // --- chain of command -----------------------------------------------------
  /**
   * Raises a new army, or an army group when `isArmyGroup` is set. An army
   * group holds armies rather than divisions, and its field marshal passes
   * half of his attributes to every general beneath him.
   */
  | { t: 'createArmy'; country: CountryId; name: string; isArmyGroup?: boolean }
  | { t: 'disbandArmy'; country: CountryId; army: ArmyId }
  | { t: 'renameArmy'; country: CountryId; army: ArmyId; name: string }
  /** Moves divisions into an army; `army: null` returns them to no command. */
  | { t: 'assignDivisions'; country: CountryId; army: ArmyId | null; divisions: DivisionId[] }
  /** Puts an officer in charge; `commander: null` leaves the post vacant. */
  | { t: 'appointCommander'; country: CountryId; army: ArmyId; commander: CommanderId | null }
  /** Places an army under an army group, or with null takes it out of one. */
  | { t: 'setArmyParent'; country: CountryId; army: ArmyId; group: ArmyId | null }
  /** The standing order the army follows and prepares for. */
  | { t: 'setArmyOrder'; country: CountryId; army: ArmyId; order: ArmyOrder | null }
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
  /**
   * Puts a technology into a research slot. Replacing a slot that is already
   * working abandons its progress, as it does in the real game.
   */
  | { t: 'startResearch'; country: CountryId; slot: number; tech: TechId }
  | { t: 'cancelResearch'; country: CountryId; slot: number }

  // --- national focus -------------------------------------------------------
  /** Cannot be changed once started; cancelling throws the progress away. */
  | { t: 'startFocus'; country: CountryId; focus: string }
  | { t: 'cancelFocus'; country: CountryId };

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
