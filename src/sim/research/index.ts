/**
 * The research module.
 *
 * `techData` is the content -- the dated trees, their Japanese names and what
 * each technology changes. `research` is the runtime -- slots, progress, the
 * ahead-of-time penalty, and the modifier record the rest of the simulation
 * reads. Nothing else in the module is public.
 */

export {
  BLOCK_REASON_TEXT, BRANCH_LIST, BRANCH_NAME, IDLE_SLOT_NAME,
  MODIFIER_KEYS, MODIFIER_KIND, MODIFIER_LABEL, TECHS, TECH_BRANCHES,
  formatModifier, techDef, techsInBranch, techOrder,
  type ModifierKey, type TechBlockReason, type TechBranch, type TechDef,
  type TechEffects,
} from './techData';

export {
  AHEAD_PENALTY_PER_YEAR, MAX_RESEARCH_SLOTS, NO_MODIFIERS,
  aheadPenalty, autoSelectResearch, availableTechs, canResearch, cancelResearch,
  completedTechs, effectiveSlotCount, effectiveTemplate, ensureSlots,
  isResearched, missingPrerequisites, requiredDays, researchBlock,
  researchSpeed, researchSummary, researchView, slotResearching, startResearch,
  techModifiers, techTree, tickResearchDaily, yearsAhead,
  type EffectView, type SlotView, type TechModifiers, type TechView,
} from './research';
