import { compileResultSchema, type CompileResult } from '../../shared/compile-result.js';
import type { Level, Operation, Requirement } from '../../shared/schema.js';
import { applyOperations, applyRuleProposal } from './level.js';
import { baselineLevel } from './fixtures/baseline.js';
import { blankCanvasLevel } from './fixtures/blank-canvas.js';
import { twinKeysLevel } from './fixtures/gallery.js';
import { trapLevel } from './fixtures/trap.js';
import { trapRepairedLevel } from './fixtures/trap-repaired.js';
import { vaultEmptyLevel } from './fixtures/vault-empty.js';
import { touchesProtected } from './search.js';
import { verify, type CheckStatus } from './verifier.js';

/**
 * Controlled, versioned cases for the reliability boundary. These are not
 * live-model results: each case supplies a known compile response so the
 * parser, atomic application, protection, preview, and verifier contract can
 * be tested without a network call or a paid provider.
 */
export type EvaluationCategory =
  | 'simple_edits'
  | 'linked_changes'
  | 'gameplay_logic'
  | 'preservation'
  | 'ambiguity'
  | 'unsupported_conflicting';

export type EvaluationDisposition = 'apply' | 'clarify' | 'reject';

export interface FixedEvaluationCase {
  id: string;
  category: EvaluationCategory;
  prompt: string;
  base: Level;
  result: CompileResult;
  disposition: EvaluationDisposition;
  expectedOutcome: string;
  acceptableAlternatives: string[];
  mustNotChange: string[];
  protectedIds?: string[];
  expectedChecks?: Partial<Record<'solution' | 'requirements' | 'recovery', CheckStatus>>;
  assertCandidate?: (candidate: Level) => string[];
}

export interface FixedEvaluationResult {
  id: string;
  category: EvaluationCategory;
  schemaValid: boolean;
  semanticFulfillment: boolean;
  protectionPreserved: boolean;
  unrelatedPreserved: boolean;
  gameplayVerified: boolean | null;
  previewApplicationConsistent: boolean;
  safeHandling: boolean;
  appliedLevel: Level | null;
  errors: string[];
}

function patch(rationale: string, operations: Operation[]): CompileResult {
  return { type: 'patch', rationale, assumptions: [], operations };
}

function rule(
  reason: string,
  oldRequirements: Requirement[],
  newRequirements: Requirement[],
  operations: Operation[] = [],
): CompileResult {
  return { type: 'rule_proposal', reason, oldRequirements, newRequirements, operations };
}

function clarification(question: string): CompileResult {
  return {
    type: 'clarification',
    question,
    choices: [
      { id: 'first', label: 'Use the first matching object' },
      { id: 'ask', label: 'Show me the matching objects' },
    ],
  };
}

function unsupported(reason: string): CompileResult {
  return {
    type: 'unsupported',
    reason,
    alternatives: ['Use a supported module, item, door, or rule edit instead.'],
  };
}

function hasKeyOn(level: Level, moduleId: string): boolean {
  return level.keys.some((key) => key.moduleId === moduleId);
}

function hasDoor(level: Level, id: string): boolean {
  return level.doors.some((door) => door.id === id);
}

function doorOnEdge(level: Level, a: string, b: string): Level['doors'][number] | undefined {
  return level.doors.find((door) => (door.a === a && door.b === b) || (door.a === b && door.b === a));
}

function doorIsOpen(door: Level['doors'][number] | undefined): boolean {
  return door !== undefined && Object.keys(door.conditions ?? {}).length === 0;
}

function checkStatuses(
  level: Level,
  expected: FixedEvaluationCase['expectedChecks'],
): string[] {
  if (expected === undefined) return [];
  const report = verify(level);
  const errors: string[] = [];
  for (const [kind, status] of Object.entries(expected)) {
    if (status === undefined) continue;
    const actual = report.checks[kind as keyof typeof report.checks].status;
    if (actual !== status) errors.push(`${kind} is ${actual}; expected ${status}`);
  }
  return errors;
}

/** Return a stable snapshot for the entity ids used by must-not-change. */
function entitySnapshot(level: Level, id: string): unknown {
  const module = level.modules.find((item) => item.id === id);
  if (module !== undefined) return { kind: 'module', value: module };
  const key = level.keys.find((item) => item.id === id);
  if (key !== undefined) return { kind: 'key', value: key };
  const switchItem = level.switches.find((item) => item.id === id);
  if (switchItem !== undefined) return { kind: 'switch', value: switchItem };
  const door = level.doors.find((item) => item.id === id);
  if (door !== undefined) return { kind: 'door', value: door };
  return undefined;
}

const brassRule = [{ type: 'collectBeforeGoal', keyId: 'brass-key' }] as Requirement[];
const goldRule = [{ type: 'collectBeforeGoal', keyId: 'gold-key' }] as Requirement[];

export const fixedEvaluationCases: readonly FixedEvaluationCase[] = [
  // Simple edits: add, move, and remove supported entities.
  {
    id: 'simple-add-key',
    category: 'simple_edits',
    prompt: 'Put a brass key on the side balcony.',
    base: vaultEmptyLevel,
    result: patch('Add the requested key.', [{ kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' }]),
    disposition: 'apply',
    expectedOutcome: 'A brass key is added to key-balcony.',
    acceptableAlternatives: [],
    mustNotChange: ['gallery', 'entrance'],
    assertCandidate: (level) => (hasKeyOn(level, 'key-balcony') ? [] : ['no key is on key-balcony']),
  },
  {
    id: 'simple-move-key',
    category: 'simple_edits',
    prompt: 'Move the brass key to the key walk.',
    base: baselineLevel,
    result: patch('Move the selected key.', [{ kind: 'moveItem', id: 'brass-key', moduleId: 'key-walk' }]),
    disposition: 'apply',
    expectedOutcome: 'The existing brass key moves to key-walk.',
    acceptableAlternatives: [],
    mustNotChange: ['vault-door', 'gallery'],
    assertCandidate: (level) => (level.keys.find((key) => key.id === 'brass-key')?.moduleId === 'key-walk' ? [] : ['brass-key did not move']),
  },
  {
    id: 'simple-add-switch',
    category: 'simple_edits',
    prompt: 'Add a named switch on the vault entry.',
    base: baselineLevel,
    result: patch('Add the switch.', [{ kind: 'addItem', itemType: 'switch', id: 'test-switch', moduleId: 'vault-entry' }]),
    disposition: 'apply',
    expectedOutcome: 'A new switch is added on vault-entry under a valid unique identifier.',
    acceptableAlternatives: ['Any valid unique switch identifier on vault-entry.'],
    mustNotChange: ['brass-key', 'vault-door'],
    assertCandidate: (level) => level.switches.length === 1 && level.switches[0]?.moduleId === 'vault-entry' ? [] : ['a single new switch is not on vault-entry'],
  },
  {
    id: 'simple-add-door',
    category: 'simple_edits',
    prompt: 'Add an open door between the upper foyer and upper gallery.',
    base: baselineLevel,
    result: patch('Add the requested door.', [{ kind: 'addDoor', door: { id: 'gallery-door', a: 'gallery', b: 'bridge-landing', conditions: {} } }]),
    disposition: 'apply',
    expectedOutcome: 'An open door with any valid unique identifier is added between the connected upper-foyer and upper-gallery modules.',
    acceptableAlternatives: ['Any valid unique door identifier on that exact edge.'],
    mustNotChange: ['brass-key', 'vault-door'],
    assertCandidate: (level) => doorIsOpen(doorOnEdge(level, 'gallery', 'bridge-landing')) ? [] : ['no open door is on the requested edge'],
  },
  {
    id: 'simple-move-goal',
    category: 'simple_edits',
    prompt: 'Move the goal onto the starting walk.',
    base: blankCanvasLevel,
    result: patch('Move the goal marker.', [{ kind: 'moveGoal', moduleId: 'start-walk' }]),
    disposition: 'apply',
    expectedOutcome: 'The goal becomes start-walk.',
    acceptableAlternatives: [],
    mustNotChange: ['entry-pad', 'start-walk'],
    assertCandidate: (level) => level.goal === 'start-walk' ? [] : ['goal did not move'],
  },
  {
    id: 'simple-remove-door',
    category: 'simple_edits',
    prompt: 'Remove the gallery door but leave the rest of the puzzle alone.',
    base: trapRepairedLevel,
    result: patch('Remove only the gallery door.', [{ kind: 'removeDoor', id: 'gallery-door' }]),
    disposition: 'apply',
    expectedOutcome: 'gallery-door is removed and the rest is unchanged.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door', 'seal-switch'],
    assertCandidate: (level) => hasDoor(level, 'gallery-door') ? ['gallery-door still exists'] : [],
  },

  // Linked changes: requirement edits are reviewed atomically with their
  // referenced objects.
  {
    id: 'linked-remove-key-rule-door',
    category: 'linked_changes',
    prompt: 'Remove the brass key, its keyed vault door, and the rule requiring it.',
    base: baselineLevel,
    result: rule('Remove the key mechanic as one change.', brassRule, [], [
      { kind: 'removeItem', id: 'brass-key' },
      { kind: 'removeDoor', id: 'vault-door' },
    ]),
    disposition: 'apply',
    expectedOutcome: 'The key, its door, and collect-before-goal rule disappear together.',
    acceptableAlternatives: [],
    mustNotChange: ['gallery', 'entrance'],
    assertCandidate: (level) => [
      level.keys.some((key) => key.id === 'brass-key') ? 'brass-key remains' : '',
      hasDoor(level, 'vault-door') ? 'vault-door remains' : '',
      level.requirements.length > 0 ? 'the requirement remains' : '',
    ].filter(Boolean),
  },
  {
    id: 'linked-reject-required-key-only',
    category: 'linked_changes',
    prompt: 'Remove the brass key but keep the rule that requires it.',
    base: baselineLevel,
    result: rule('This request leaves a dangling rule and must be rejected.', brassRule, brassRule, [{ kind: 'removeItem', id: 'brass-key' }]),
    disposition: 'reject',
    expectedOutcome: 'The invalid linked removal is rejected without mutating the level.',
    acceptableAlternatives: ['Ask to remove the requirement and dependent door too.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },
  {
    id: 'linked-remove-rule-keep-key',
    category: 'linked_changes',
    prompt: 'Keep the brass key and door, but make collecting the key optional.',
    base: baselineLevel,
    result: rule('Remove only the active requirement.', brassRule, []),
    disposition: 'apply',
    expectedOutcome: 'The key and door remain, while the requirement list becomes empty.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door'],
    assertCandidate: (level) => [
      level.requirements.length === 0 ? '' : 'requirement remains',
      level.keys.some((key) => key.id === 'brass-key') ? '' : 'brass-key was removed',
      hasDoor(level, 'vault-door') ? '' : 'vault-door was removed',
    ].filter(Boolean),
  },
  {
    id: 'linked-remove-door-rule',
    category: 'linked_changes',
    prompt: 'Remove the keyed vault door and its collect-before-goal rule, but leave the key as decoration.',
    base: baselineLevel,
    result: rule('Remove the gate and active rule; preserve the key.', brassRule, [], [{ kind: 'removeDoor', id: 'vault-door' }]),
    disposition: 'apply',
    expectedOutcome: 'The door and rule are removed; brass-key remains.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'gallery'],
    assertCandidate: (level) => [
      hasDoor(level, 'vault-door') ? 'vault-door remains' : '',
      level.requirements.length > 0 ? 'requirement remains' : '',
      level.keys.some((key) => key.id === 'brass-key') ? '' : 'brass-key disappeared',
    ].filter(Boolean),
  },
  {
    id: 'linked-twin-key-revision',
    category: 'linked_changes',
    prompt: 'Remove the silver key mechanic while keeping the gold key requirement.',
    base: twinKeysLevel,
    result: rule('Drop the silver requirement and its dependent gates.', twinKeysLevel.requirements, goldRule, [
      { kind: 'removeItem', id: 'silver-key' },
      { kind: 'removeDoor', id: 'gold-wing-door' },
      { kind: 'removeDoor', id: 'outer-vault-door' },
    ]),
    disposition: 'apply',
    expectedOutcome: 'Silver key and its dependent doors are removed atomically; gold remains required.',
    acceptableAlternatives: [],
    mustNotChange: ['gold-key', 'vault-power', 'inner-vault-door'],
    assertCandidate: (level) => [
      level.keys.some((key) => key.id === 'silver-key') ? 'silver-key remains' : '',
      level.requirements.some((item) => item.type === 'collectBeforeGoal' && item.keyId === 'gold-key') ? '' : 'gold rule is missing',
    ].filter(Boolean),
  },
  {
    id: 'linked-requirement-target-update',
    category: 'linked_changes',
    prompt: 'Require every winning route to cross the upper gallery instead of requiring the key.',
    base: baselineLevel,
    result: rule('Replace the active requirement with the requested route requirement.', brassRule, [{ type: 'passThrough', moduleId: 'bridge-landing' }]),
    disposition: 'apply',
    expectedOutcome: 'The requirement changes without changing geometry.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door', 'gallery'],
    assertCandidate: (level) => level.requirements.length === 1 && level.requirements[0]?.type === 'passThrough' && level.requirements[0].moduleId === 'bridge-landing' ? [] : ['route requirement was not updated'],
  },

  // Gameplay logic: deliberately include green, trapped, and bypassing
  // candidates so an unsolved but faithful request is not counted as an AI
  // failure.
  {
    id: 'logic-build-keyed-vault',
    category: 'gameplay_logic',
    prompt: 'Add a key to the side balcony, add a door between vault-approach and vault-entry that requires that key, and require the key before the goal.',
    base: vaultEmptyLevel,
    result: rule('Add the key rule and its keyed gate.', [], brassRule, [
      { kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' },
      { kind: 'addDoor', door: { id: 'vault-door', a: 'vault-approach', b: 'vault-entry', conditions: { requiresKey: 'brass-key' } } },
    ]),
    disposition: 'apply',
    expectedOutcome: 'A key is placed on the side balcony, a door on the named vault edge requires that same key, and the collect-before-goal rule references it.',
    acceptableAlternatives: ['Any valid unique identifiers, as long as the key, door condition, and rule refer to the same key.'],
    mustNotChange: ['gallery', 'entrance'],
    expectedChecks: { solution: 'pass', requirements: 'pass', recovery: 'pass' },
    assertCandidate: (level) => {
      const key = level.keys.find((item) => item.moduleId === 'key-balcony');
      if (key === undefined || level.keys.length !== 1) return ['exactly one key is not on key-balcony'];
      const door = doorOnEdge(level, 'vault-approach', 'vault-entry');
      if (door?.conditions?.requiresKey !== key.id) return ['the vault door does not require the balcony key'];
      return level.requirements.some((item) => item.type === 'collectBeforeGoal' && item.keyId === key.id)
        ? []
        : ['the collect-before-goal rule does not reference the balcony key'];
    },
  },
  {
    id: 'logic-surface-switch-trap',
    category: 'gameplay_logic',
    prompt: 'Add a switch on vault-approach that permanently closes the door between gallery and bridge-landing when activated.',
    base: baselineLevel,
    result: patch('Add the switch and the door that seals after it.', [
      { kind: 'addItem', itemType: 'switch', id: 'seal-switch', moduleId: 'vault-approach' },
      { kind: 'addDoor', door: { id: 'gallery-door', a: 'gallery', b: 'bridge-landing', conditions: { closesAfterSwitch: 'seal-switch' } } },
    ]),
    disposition: 'apply',
    expectedOutcome: 'The trap is applied and the recovery failure is visible.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door'],
    expectedChecks: { solution: 'pass', requirements: 'pass', recovery: 'fail' },
    assertCandidate: (level) => {
      const switchItem = level.switches.find((item) => item.moduleId === 'vault-approach');
      const door = doorOnEdge(level, 'gallery', 'bridge-landing');
      return switchItem !== undefined && door?.conditions?.closesAfterSwitch === switchItem.id
        ? []
        : ['no switch on vault-approach is linked to a closing door on the requested edge'];
    },
  },
  {
    id: 'logic-repair-switch-trap',
    category: 'gameplay_logic',
    prompt: 'Move seal-switch behind the keyed vault door so the trap becomes recoverable.',
    base: trapLevel,
    result: patch('Move the switch to the vault entry.', [{ kind: 'moveItem', id: 'seal-switch', moduleId: 'vault-entry' }]),
    disposition: 'apply',
    expectedOutcome: 'The repair produces an accepted level.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door', 'gallery-door'],
    expectedChecks: { solution: 'pass', requirements: 'pass', recovery: 'pass' },
    assertCandidate: (level) => level.switches.find((item) => item.id === 'seal-switch')?.moduleId === 'vault-entry' ? [] : ['seal-switch did not move'],
  },
  {
    id: 'logic-remove-gate-condition',
    category: 'gameplay_logic',
    prompt: 'Leave the vault door in place but remove its key condition.',
    base: baselineLevel,
    result: patch('Open the existing vault door.', [{ kind: 'setDoorConditions', id: 'vault-door', conditions: {} }]),
    disposition: 'apply',
    expectedOutcome: 'The candidate is valid but fails the key requirement with a bypass witness.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'gallery'],
    expectedChecks: { solution: 'pass', requirements: 'fail' },
    assertCandidate: (level) => {
      const conditions = level.doors.find((door) => door.id === 'vault-door')?.conditions;
      return conditions !== undefined && Object.keys(conditions).length === 0 ? [] : ['vault-door condition was not removed'];
    },
  },
  {
    id: 'logic-goal-before-key',
    category: 'gameplay_logic',
    prompt: 'Move the goal to the upper foyer.',
    base: baselineLevel,
    result: patch('Move the goal to gallery.', [{ kind: 'moveGoal', moduleId: 'gallery' }]),
    disposition: 'apply',
    expectedOutcome: 'The draft is valid, but the requirement check exposes the early goal.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door'],
    expectedChecks: { solution: 'pass', requirements: 'fail' },
    assertCandidate: (level) => level.goal === 'gallery' ? [] : ['goal did not move'],
  },
  {
    id: 'logic-remove-rule-only',
    category: 'gameplay_logic',
    prompt: 'Make the brass key optional while preserving the existing gate.',
    base: baselineLevel,
    result: rule('Remove the requirement but keep the key and door.', brassRule, []),
    disposition: 'apply',
    expectedOutcome: 'The scene remains playable and the active rule list is empty.',
    acceptableAlternatives: [],
    mustNotChange: ['brass-key', 'vault-door', 'gallery'],
    expectedChecks: { solution: 'pass', requirements: 'not_applicable', recovery: 'pass' },
    assertCandidate: (level) => level.requirements.length === 0 ? [] : ['rule remains'],
  },

  // Preservation cases make protection and unrelated-change assertions
  // explicit rather than treating a valid candidate as sufficient.
  {
    id: 'preserve-protected-module',
    category: 'preservation',
    prompt: 'Move the kept upper foyer elsewhere.',
    base: baselineLevel,
    result: unsupported('This module is marked Keep these. Unkeep it before moving it.'),
    disposition: 'reject',
    expectedOutcome: 'A protected module is not changed.',
    acceptableAlternatives: ['Ask the creator to unkeep gallery before moving it.'],
    mustNotChange: ['gallery', 'brass-key'],
    protectedIds: ['gallery'],
  },
  {
    id: 'preserve-unrelated-geometry',
    category: 'preservation',
    prompt: 'Move only the brass key to the key walk.',
    base: baselineLevel,
    result: patch('Move only the key.', [{ kind: 'moveItem', id: 'brass-key', moduleId: 'key-walk' }]),
    disposition: 'apply',
    expectedOutcome: 'The key moves while unrelated modules and the vault door remain identical.',
    acceptableAlternatives: [],
    mustNotChange: ['gallery', 'vault-door', 'entrance'],
    protectedIds: ['gallery'],
    assertCandidate: (level) => level.keys.find((key) => key.id === 'brass-key')?.moduleId === 'key-walk' ? [] : ['key did not move'],
  },
  {
    id: 'preserve-protected-key',
    category: 'preservation',
    prompt: 'Remove the brass key even though it is kept.',
    base: baselineLevel,
    result: unsupported('This key is marked Keep these. Unkeep it before removing it.'),
    disposition: 'reject',
    expectedOutcome: 'A kept key cannot be removed.',
    acceptableAlternatives: ['Ask the creator to unkeep brass-key first.'],
    mustNotChange: ['brass-key', 'vault-door'],
    protectedIds: ['brass-key'],
  },
  {
    id: 'preserve-protected-switch',
    category: 'preservation',
    prompt: 'Move the kept seal switch to the bridge landing.',
    base: trapLevel,
    result: unsupported('This switch is marked Keep these. Unkeep it before moving it.'),
    disposition: 'reject',
    expectedOutcome: 'The kept switch remains at the vault approach.',
    acceptableAlternatives: ['Ask the creator to unkeep seal-switch first.'],
    mustNotChange: ['seal-switch', 'gallery-door', 'vault-door'],
    protectedIds: ['seal-switch'],
  },

  // Ambiguous requests stop at a question; no geometry is applied.
  {
    id: 'ambiguity-better-key-spot',
    category: 'ambiguity',
    prompt: 'Move the key to a better spot.',
    base: baselineLevel,
    result: clarification('Which module should hold the key?'),
    disposition: 'clarify',
    expectedOutcome: 'Ask the author to identify the destination.',
    acceptableAlternatives: ['Offer a list of visible candidate modules.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },
  {
    id: 'ambiguity-the-door',
    category: 'ambiguity',
    prompt: 'Add a door on the way to the treasure.',
    base: baselineLevel,
    result: clarification('Which connected edge should receive the door?'),
    disposition: 'clarify',
    expectedOutcome: 'Ask which edge is intended.',
    acceptableAlternatives: ['Show the connected edges as choices.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },
  {
    id: 'ambiguity-switch-location',
    category: 'ambiguity',
    prompt: 'Put a switch near the vault.',
    base: baselineLevel,
    result: clarification('Should the switch sit on vault-approach or vault-entry?'),
    disposition: 'clarify',
    expectedOutcome: 'Ask for the exact module.',
    acceptableAlternatives: ['Offer nearby modules as choices.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },
  {
    id: 'ambiguity-which-goal',
    category: 'ambiguity',
    prompt: 'Move the goal upstairs.',
    base: baselineLevel,
    result: clarification('Which upper module should become the goal?'),
    disposition: 'clarify',
    expectedOutcome: 'Ask for a specific goal module.',
    acceptableAlternatives: ['Offer the upper foyer, upper gallery, and vault entry.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },

  // Unsupported or contradictory requests are safe, visible rejections.
  {
    id: 'unsupported-jumping',
    category: 'unsupported_conflicting',
    prompt: 'Add a gap the player has to jump across.',
    base: baselineLevel,
    result: unsupported('Jumping and gaps are not part of the supported movement schema.'),
    disposition: 'reject',
    expectedOutcome: 'Explain the unsupported mechanic and keep the scene unchanged.',
    acceptableAlternatives: ['Use a bridge, ramp, or door instead.'],
    mustNotChange: ['brass-key', 'vault-door', 'gallery'],
  },
  {
    id: 'unsupported-multiplayer',
    category: 'unsupported_conflicting',
    prompt: 'Add a second player controlled by another browser.',
    base: baselineLevel,
    result: unsupported('Multiplayer collaboration is outside the current scene schema.'),
    disposition: 'reject',
    expectedOutcome: 'Reject the unsupported account/network feature without mutation.',
    acceptableAlternatives: ['Use the deterministic ghost replay to show another run.'],
    mustNotChange: ['brass-key', 'vault-door', 'gallery'],
  },
  {
    id: 'unsupported-conflicting-gate',
    category: 'unsupported_conflicting',
    prompt: 'Make the vault door require a key that does not exist, but keep the puzzle accepted.',
    base: baselineLevel,
    result: unsupported('A door cannot require an unknown key while remaining valid.'),
    disposition: 'reject',
    expectedOutcome: 'Reject the contradictory request and keep the accepted checkpoint.',
    acceptableAlternatives: ['Add a supported key first, then review the resulting checks.'],
    mustNotChange: ['brass-key', 'vault-door'],
  },
  {
    id: 'unsupported-repeat-door',
    category: 'unsupported_conflicting',
    prompt: 'Require the player to pass through the same door twice before the goal.',
    base: baselineLevel,
    result: unsupported('Repeated traversal requirements are not supported by the current rule vocabulary.'),
    disposition: 'reject',
    expectedOutcome: 'Reject the unsupported traversal rule without changing geometry.',
    acceptableAlternatives: ['Use a key, switch, pass-through, or collect-before-goal rule.'],
    mustNotChange: ['brass-key', 'vault-door', 'gallery'],
  },
] as const;

export function evaluateFixedCase(testCase: FixedEvaluationCase): FixedEvaluationResult {
  const parsed = compileResultSchema.safeParse(testCase.result);
  const errors: string[] = [];
  if (!parsed.success) {
    return {
      id: testCase.id,
      category: testCase.category,
      schemaValid: false,
      semanticFulfillment: false,
      protectionPreserved: false,
      unrelatedPreserved: false,
      gameplayVerified: null,
      previewApplicationConsistent: false,
      safeHandling: true,
      appliedLevel: null,
      errors: [parsed.error.issues[0]?.message ?? 'compile result failed schema validation'],
    };
  }

  const result = parsed.data;
  const shouldApply = testCase.disposition === 'apply';
  const isQuestion = testCase.disposition === 'clarify';
  const typeMatches = shouldApply
    ? result.type === 'patch' || result.type === 'rule_proposal'
    : isQuestion
      ? result.type === 'clarification'
      : result.type === 'unsupported' || result.type === 'rule_proposal' || result.type === 'patch';
  if (!typeMatches) errors.push(`received ${result.type} for ${testCase.disposition}`);

  if (!shouldApply) {
    let safeHandling = true;
    let protectionPreserved = true;
    if (result.type === 'patch' || result.type === 'rule_proposal') {
      const operations = result.operations;
      const protectedRequest = testCase.protectedIds !== undefined && touchesProtected(operations, new Set(testCase.protectedIds), testCase.base);
      const attempted = result.type === 'rule_proposal'
        ? applyRuleProposal(testCase.base, result)
        : applyOperations(testCase.base, operations);
      protectionPreserved = !protectedRequest;
      if (!protectionPreserved) errors.push('proposal touches an entity marked Keep these');
      safeHandling = protectedRequest || !attempted.ok;
      if (!safeHandling) errors.push('rejected case would have applied a valid unprotected candidate');
    }
    return {
      id: testCase.id,
      category: testCase.category,
      schemaValid: true,
      semanticFulfillment: errors.length === 0,
      protectionPreserved,
      unrelatedPreserved: true,
      gameplayVerified: null,
      previewApplicationConsistent: true,
      safeHandling,
      appliedLevel: null,
      errors,
    };
  }

  const firstApplied = result.type === 'rule_proposal'
    ? applyRuleProposal(testCase.base, result)
    : result.type === 'patch'
      ? applyOperations(testCase.base, result.operations)
      : { ok: false as const, errors: ['not an applicable result'] };
  const secondApplied = result.type === 'rule_proposal'
    ? applyRuleProposal(testCase.base, result)
    : result.type === 'patch'
      ? applyOperations(testCase.base, result.operations)
      : { ok: false as const, errors: ['not an applicable result'] };
  if (!firstApplied.ok) errors.push(`application rejected: ${firstApplied.errors[0]}`);
  if (!secondApplied.ok) errors.push(`repeat application rejected: ${secondApplied.errors[0]}`);
  const candidate = firstApplied.ok ? firstApplied.level : null;
  const repeatCandidate = secondApplied.ok ? secondApplied.level : null;
  const previewApplicationConsistent = candidate !== null && repeatCandidate !== null && JSON.stringify(candidate) === JSON.stringify(repeatCandidate);
  if (!previewApplicationConsistent) errors.push('repeated approval did not produce the same candidate');

  let protectionPreserved = true;
  if (candidate !== null && testCase.protectedIds !== undefined && (result.type === 'patch' || result.type === 'rule_proposal')) {
    protectionPreserved = !touchesProtected(result.operations, new Set(testCase.protectedIds), testCase.base);
    if (!protectionPreserved) errors.push('candidate touches a protected entity');
  }

  let unrelatedPreserved = true;
  if (candidate !== null) {
    for (const id of testCase.mustNotChange) {
      if (JSON.stringify(entitySnapshot(testCase.base, id)) !== JSON.stringify(entitySnapshot(candidate, id))) {
        unrelatedPreserved = false;
        errors.push(`must-not-change entity mutated: ${id}`);
      }
    }
  }
  if (candidate !== null && testCase.assertCandidate !== undefined) errors.push(...testCase.assertCandidate(candidate));
  if (candidate !== null) errors.push(...checkStatuses(candidate, testCase.expectedChecks));
  const gameplayVerified = testCase.expectedChecks === undefined ? null : candidate !== null && errors.length === 0;

  return {
    id: testCase.id,
    category: testCase.category,
    schemaValid: true,
    semanticFulfillment: errors.length === 0,
    protectionPreserved,
    unrelatedPreserved,
    gameplayVerified,
    previewApplicationConsistent,
    safeHandling: true,
    appliedLevel: candidate,
    errors,
  };
}

export function fixedEvaluationSummary() {
  const results = fixedEvaluationCases.map(evaluateFixedCase);
  const byCategory = Object.fromEntries(
    (['simple_edits', 'linked_changes', 'gameplay_logic', 'preservation', 'ambiguity', 'unsupported_conflicting'] as EvaluationCategory[]).map((category) => {
      const subset = results.filter((result) => result.category === category);
      return [category, { total: subset.length, passed: subset.filter((result) => result.semanticFulfillment).length }];
    }),
  ) as Record<EvaluationCategory, { total: number; passed: number }>;
  return { total: results.length, passed: results.filter((result) => result.semanticFulfillment).length, byCategory, results };
}
