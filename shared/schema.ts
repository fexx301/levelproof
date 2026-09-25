import { z } from 'zod';

/**
 * Shared bounded schemas for LevelProof.
 * Contract: levelBuild.md v3.1 §§4-6. Strict everywhere: unknown fields and
 * unknown operation kinds are rejected, never stripped.
 */

/** Hard bounds from the implementation contract (§4.1, §5, §6). */
export const BOUNDS = {
  maxX: 15,
  maxZ: 15,
  maxElevation: 2,
  maxModules: 256,
  maxKeys: 3,
  maxSwitches: 4,
  maxRequirements: 3,
  maxDoors: 64,
  maxProps: 24,
  // A from-scratch build plus its scenery (environment and a handful of
  // landmark props) needs more room than a single gameplay edit.
  maxOpsPerPatch: 32,
  maxStringLength: 64,
} as const;

export const CARDINALS = ['N', 'E', 'S', 'W'] as const;
export type Cardinal = (typeof CARDINALS)[number];

const idRegex = /^[a-z][a-z0-9-]{1,31}$/;

export const idSchema = z
  .string()
  .regex(idRegex, 'id must be 2-32 chars: [a-z][a-z0-9]-, starting with a letter');

export const cardinalSchema = z.enum(CARDINALS);

export const templateSchema = z.enum(['flat', 'ramp', 'bridge']);
export type TemplateKind = z.infer<typeof templateSchema>;

const anchorFields = {
  x: z.number().int().min(0).max(BOUNDS.maxX),
  z: z.number().int().min(0).max(BOUNDS.maxZ),
  h: z.number().int().min(0).max(BOUNDS.maxElevation),
} as const;

export const moduleSchema = z.strictObject({
  id: idSchema,
  template: templateSchema,
  ...anchorFields,
  /** Direction of ascent; required for ramps, unused by flat/bridge. */
  orientation: cardinalSchema.optional(),
  /** Human-facing name exposed in the scene summary (§8). */
  label: z.string().max(BOUNDS.maxStringLength).optional(),
  /** Physical cardinal openings on this module. */
  ports: z.array(cardinalSchema).max(4),
});
export type LevelModule = z.infer<typeof moduleSchema>;

// ---------------------------------------------------------------------------
// Scenery (cosmetic). The verifier, movement engine, and repair search never
// read these fields: they let the world look like what the author described
// (a spooky forest, a dragon by the gate, a torch instead of a key) without
// adding any mechanic the engine cannot prove.
// ---------------------------------------------------------------------------

/** Architecture palettes; also the author's explicit theme override. */
export const THEME_KEYS = ['limestone', 'ivory', 'patina', 'basalt', 'futuristic'] as const;
export const themeKeySchema = z.enum(THEME_KEYS);
export type ThemeKey = z.infer<typeof themeKeySchema>;

export const ENVIRONMENTS = [
  'void', 'meadow', 'forest', 'swamp', 'desert', 'snow', 'volcanic', 'cavern', 'sea', 'space', 'city',
] as const;
export const environmentSchema = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof environmentSchema>;

export const LIGHTINGS = ['day', 'dusk', 'night'] as const;
export const lightingSchema = z.enum(LIGHTINGS);
export type Lighting = z.infer<typeof lightingSchema>;

export const PROP_KINDS = [
  'tree', 'pine', 'dead-tree', 'palm', 'bush', 'rock', 'crystal', 'mushroom', 'cactus',
  'brazier', 'torch', 'lantern', 'campfire', 'candles',
  'banner', 'statue', 'dragon', 'pillar', 'ruin', 'gravestone',
  'chest', 'throne', 'barrel', 'fountain', 'portal', 'console', 'antenna',
  'water', 'lava',
] as const;
export const propKindSchema = z.enum(PROP_KINDS);
export type PropKind = z.infer<typeof propKindSchema>;

/** Ground tiles: they lie flat on open ground, never on a ground-level module. */
export const GROUND_TILE_PROPS: ReadonlySet<PropKind> = new Set(['water', 'lava']);

export const KEY_LOOKS = ['key', 'torch', 'lantern', 'gem', 'orb', 'crown', 'scroll', 'keycard', 'amulet'] as const;
export const keyLookSchema = z.enum(KEY_LOOKS);
export type KeyLook = z.infer<typeof keyLookSchema>;

export const scenerySchema = z.strictObject({
  environment: environmentSchema.optional(),
  lighting: lightingSchema.optional(),
  architecture: themeKeySchema.optional(),
});
export type Scenery = z.infer<typeof scenerySchema>;

/** A decorative landmark on grid cell (x, z): on the highest module there, or on open ground. */
export const propSchema = z.strictObject({
  id: idSchema,
  prop: propKindSchema,
  x: z.number().int().min(0).max(BOUNDS.maxX),
  z: z.number().int().min(0).max(BOUNDS.maxZ),
});
export type Prop = z.infer<typeof propSchema>;

export const keyItemSchema = z.strictObject({ id: idSchema, moduleId: idSchema, look: keyLookSchema.optional() });
export const switchItemSchema = z.strictObject({ id: idSchema, moduleId: idSchema });

/**
 * Door conditions (§4.3). All conditions must allow traversal:
 * requiresKey and requiresSwitch gate passage; closesAfterSwitch seals the
 * door permanently once that switch activates.
 */
export const doorConditionsSchema = z.strictObject({
  requiresKey: idSchema.optional(),
  /** AND semantics: every listed key must be held (at most 3, one per kit key). */
  requiresKeys: z.array(idSchema).max(3).optional(),
  requiresSwitch: idSchema.optional(),
  closesAfterSwitch: idSchema.optional(),
});
export type DoorConditions = z.infer<typeof doorConditionsSchema>;

/** A door occupies a shared edge between two connected modules (§4.3). */
export const doorSchema = z.strictObject({
  id: idSchema,
  a: idSchema,
  b: idSchema,
  conditions: doorConditionsSchema.optional(),
});
export type Door = z.infer<typeof doorSchema>;

/** Supported requirement kinds (§5, extended): collect a key before the
 * goal; every winning route must pass through a module; every winning route
 * must have activated a switch. All are checked exhaustively against every
 * reachable goal state. */
export const requirementSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('collectBeforeGoal'), keyId: idSchema }),
  z.strictObject({ type: z.literal('passThrough'), moduleId: idSchema }),
  z.strictObject({ type: z.literal('switchNecessary'), switchId: idSchema }),
]);
export type Requirement = z.infer<typeof requirementSchema>;

export const levelSchema = z.strictObject({
  modules: z.array(moduleSchema).max(BOUNDS.maxModules),
  keys: z.array(keyItemSchema).max(BOUNDS.maxKeys),
  switches: z.array(switchItemSchema).max(BOUNDS.maxSwitches),
  spawn: idSchema,
  goal: idSchema,
  doors: z.array(doorSchema).max(BOUNDS.maxDoors),
  requirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
  /** Cosmetic world dressing; absent on levels that predate it. */
  scenery: scenerySchema.optional(),
  props: z.array(propSchema).max(BOUNDS.maxProps).optional(),
});
export type Level = z.infer<typeof levelSchema>;

// ---------------------------------------------------------------------------
// Edit vocabulary (§5). Rule changes are NEVER part of this union: they ride
// the separate ruleProposalSchema and require their own review.
// ---------------------------------------------------------------------------

export const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('addModule'), module: moduleSchema }),
  z.strictObject({ kind: z.literal('removeModule'), id: idSchema }),
  z.strictObject({
    kind: z.literal('moveModule'),
    id: idSchema,
    ...anchorFields,
    orientation: cardinalSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('setModulePorts'), id: idSchema, ports: z.array(cardinalSchema).max(4) }),
  z.strictObject({ kind: z.literal('setModuleLabel'), id: idSchema, label: z.string().min(1).max(60) }),
  z.strictObject({
    kind: z.literal('addItem'),
    itemType: z.enum(['key', 'switch']),
    id: idSchema,
    moduleId: idSchema,
    /** Keys only: how the key looks (a torch, a gem). Cosmetic. */
    look: keyLookSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('moveItem'), id: idSchema, moduleId: idSchema }),
  z.strictObject({ kind: z.literal('removeItem'), id: idSchema }),
  z.strictObject({ kind: z.literal('moveSpawn'), moduleId: idSchema }),
  z.strictObject({ kind: z.literal('moveGoal'), moduleId: idSchema }),
  z.strictObject({ kind: z.literal('addDoor'), door: doorSchema }),
  z.strictObject({ kind: z.literal('setDoorConditions'), id: idSchema, conditions: doorConditionsSchema }),
  z.strictObject({ kind: z.literal('removeDoor'), id: idSchema }),
  // Scenery operations: cosmetic only, never read by the engine.
  z.strictObject({
    kind: z.literal('setScenery'),
    environment: environmentSchema.optional(),
    lighting: lightingSchema.optional(),
    architecture: themeKeySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('addProp'),
    id: idSchema,
    prop: propKindSchema,
    x: z.number().int().min(0).max(BOUNDS.maxX),
    z: z.number().int().min(0).max(BOUNDS.maxZ),
  }),
  z.strictObject({
    kind: z.literal('moveProp'),
    id: idSchema,
    x: z.number().int().min(0).max(BOUNDS.maxX),
    z: z.number().int().min(0).max(BOUNDS.maxZ),
  }),
  z.strictObject({ kind: z.literal('removeProp'), id: idSchema }),
  z.strictObject({ kind: z.literal('setKeyLook'), id: idSchema, look: keyLookSchema }),
]);
export type Operation = z.infer<typeof operationSchema>;

/** Operation kinds that only change how the world looks. */
export const SCENERY_OPERATION_KINDS: ReadonlySet<Operation['kind']> = new Set([
  'setScenery', 'addProp', 'moveProp', 'removeProp', 'setKeyLook',
]);

export const patchSchema = z.strictObject({
  baseRevision: z.string().min(1).max(128),
  operations: z.array(operationSchema).max(BOUNDS.maxOpsPerPatch),
  rationale: z.string().max(2000).optional(),
});
export type Patch = z.infer<typeof patchSchema>;

/** Rule revision with its own visible diff and explicit approval (§5). */
export const ruleProposalSchema = z.strictObject({
  baseRevision: z.string().min(1).max(128),
  oldRequirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
  newRequirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
  reason: z.string().min(1).max(2000),
  operations: z.array(operationSchema).max(BOUNDS.maxOpsPerPatch).optional(),
});
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
