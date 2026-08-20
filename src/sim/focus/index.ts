/**
 * The national focus module.
 *
 * `focusData` is the content -- the trees themselves, their Japanese names and
 * descriptions, and what each focus does. `focus` is the runtime -- selection
 * rules, the daily tick, and the effects applied on completion. Nothing else
 * in the module is public.
 */

export {
  FOCUS_DAYS, FOCUS_DAYS_SHORT, GENERIC_TREE, NATIONAL_TREES,
  focusDef, focusTreeFor,
  type FactoryKind, type FocusCondition, type FocusDef, type FocusEffect,
  type FocusTree, type ResearchBranch,
} from './focusData';

export {
  autoSelectFocus, availableFocuses, blockText, cancelFocus, completedFocuses,
  conditionText, currentFocus, effectText, ensureFocus, exclusiveWith,
  focusBlock, focusName, startFocus, tickFocusDaily,
  type FocusBlock, type FocusContext, type FocusView,
} from './focus';
