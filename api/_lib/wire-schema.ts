/**
 * JSON Schema sent as `response_format` (strict). Mirrors the Zod contract
 * in compile-result.ts plus the shared operation vocabulary. Type-specific
 * fields are nullable placeholders that the normalizer strips. OpenAI-style
 * strict mode requires every property in `required`.
 */

const idJson = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' } as const;
const cardinalJson = { type: 'string', enum: ['N', 'E', 'S', 'W'] } as const;
const nullableCardinalJson = { type: ['string', 'null'], enum: ['N', 'E', 'S', 'W', null] } as const;

const moduleJson = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'template', 'x', 'z', 'h', 'orientation', 'label', 'ports'],
  properties: {
    id: idJson,
    template: { type: 'string', enum: ['flat', 'ramp', 'bridge'] },
    x: { type: 'integer', minimum: 0, maximum: 15 },
    z: { type: 'integer', minimum: 0, maximum: 15 },
    h: { type: 'integer', minimum: 0, maximum: 2 },
    orientation: nullableCardinalJson,
    label: { type: ['string', 'null'] },
    ports: { type: 'array', items: cardinalJson, maxItems: 4 },
  },
} as const;

const conditionsJson = {
  type: 'object',
  additionalProperties: false,
  required: ['requiresKey', 'requiresSwitch', 'closesAfterSwitch'],
  properties: {
    requiresKey: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9-]{1,31}$' },
    requiresSwitch: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9-]{1,31}$' },
    closesAfterSwitch: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9-]{1,31}$' },
  },
} as const;

const requirementJson = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'keyId'],
  properties: {
    type: { type: 'string', enum: ['collectBeforeGoal'] },
    keyId: idJson,
  },
} as const;

const operationJson = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'module'],
      properties: { kind: { type: 'string', enum: ['addModule'] }, module: moduleJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { type: 'string', enum: ['removeModule'] }, id: idJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'x', 'z', 'h', 'orientation'],
      properties: {
        kind: { type: 'string', enum: ['moveModule'] },
        id: idJson,
        x: { type: 'integer', minimum: 0, maximum: 15 },
        z: { type: 'integer', minimum: 0, maximum: 15 },
        h: { type: 'integer', minimum: 0, maximum: 2 },
        orientation: nullableCardinalJson,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'ports'],
      properties: {
        kind: { type: 'string', enum: ['setModulePorts'] },
        id: idJson,
        ports: { type: 'array', items: cardinalJson, maxItems: 4 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'itemType', 'id', 'moduleId'],
      properties: {
        kind: { type: 'string', enum: ['addItem'] },
        itemType: { type: 'string', enum: ['key', 'switch'] },
        id: idJson,
        moduleId: idJson,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'moduleId'],
      properties: { kind: { type: 'string', enum: ['moveItem'] }, id: idJson, moduleId: idJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { type: 'string', enum: ['removeItem'] }, id: idJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'moduleId'],
      properties: { kind: { type: 'string', enum: ['moveSpawn'] }, moduleId: idJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'moduleId'],
      properties: { kind: { type: 'string', enum: ['moveGoal'] }, moduleId: idJson },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'door'],
      properties: {
        kind: { type: 'string', enum: ['addDoor'] },
        door: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'a', 'b', 'conditions'],
          properties: { id: idJson, a: idJson, b: idJson, conditions: conditionsJson },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'conditions'],
      properties: {
        kind: { type: 'string', enum: ['setDoorConditions'] },
        id: idJson,
        conditions: conditionsJson,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { type: 'string', enum: ['removeDoor'] }, id: idJson },
    },
  ],
} as const;

export const compileResultJsonSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'rationale', 'assumptions', 'operations'],
      properties: {
        type: { type: 'string', enum: ['patch'] },
        rationale: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        operations: { type: 'array', items: operationJson, maxItems: 16 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'question', 'choices'],
      properties: {
        type: { type: 'string', enum: ['clarification'] },
        question: { type: 'string' },
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: { id: idJson, label: { type: 'string' } },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'reason', 'oldRequirements', 'newRequirements', 'operations'],
      properties: {
        type: { type: 'string', enum: ['rule_proposal'] },
        reason: { type: 'string' },
        oldRequirements: { type: 'array', items: requirementJson, maxItems: 3 },
        newRequirements: { type: 'array', items: requirementJson, maxItems: 3 },
        operations: { type: 'array', items: operationJson, maxItems: 16 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'reason', 'alternatives'],
      properties: {
        type: { type: 'string', enum: ['unsupported'] },
        reason: { type: 'string' },
        alternatives: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
      },
    },
  ],
} as const;
