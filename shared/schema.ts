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
  maxOpsPerPatch: 16,
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

export const keyItemSchema = z.strictObject({ id: idSchema, moduleId: idSchema });
export const switchItemSchema = z.strictObject({ id: idSchema, moduleId: idSchema });

/**
 * Door conditions (§4.3). All conditions must allow traversal:
 * requiresKey and requiresSwitch gate passage; closesAfterSwitch seals the
 * door permanently once that switch activates.
 */
export const doorConditionsSchema = z.strictObject({
  requiresKey: idSchema.optional(),
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

/** The only supported requirement type in the first slice (§5). */
export const requirementSchema = z.strictObject({
  type: z.literal('collectBeforeGoal'),
  keyId: idSchema,
});
export type Requirement = z.infer<typeof requirementSchema>;

export const levelSchema = z.strictObject({
  modules: z.array(moduleSchema).max(BOUNDS.maxModules),
  keys: z.array(keyItemSchema).max(BOUNDS.maxKeys),
  switches: z.array(switchItemSchema).max(BOUNDS.maxSwitches),
  spawn: idSchema,
  goal: idSchema,
  doors: z.array(doorSchema).max(BOUNDS.maxDoors),
  requirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
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
  z.strictObject({
    kind: z.literal('addItem'),
    itemType: z.enum(['key', 'switch']),
    id: idSchema,
    moduleId: idSchema,
  }),
  z.strictObject({ kind: z.literal('moveItem'), id: idSchema, moduleId: idSchema }),
  z.strictObject({ kind: z.literal('removeItem'), id: idSchema }),
  z.strictObject({ kind: z.literal('moveSpawn'), moduleId: idSchema }),
  z.strictObject({ kind: z.literal('moveGoal'), moduleId: idSchema }),
  z.strictObject({ kind: z.literal('addDoor'), door: doorSchema }),
  z.strictObject({ kind: z.literal('setDoorConditions'), id: idSchema, conditions: doorConditionsSchema }),
  z.strictObject({ kind: z.literal('removeDoor'), id: idSchema }),
]);
export type Operation = z.infer<typeof operationSchema>;

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
