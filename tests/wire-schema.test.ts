import { describe, expect, it } from 'vitest';
import { compileResultJsonSchema } from '../api/_lib/wire-schema';

describe('provider JSON schema', () => {
  it('accepts every strict requirement variant and keeps addItem typed', () => {
    type Node = {
      anyOf?: Node[];
      items?: Node;
      properties?: Record<string, Node>;
      enum?: string[];
      type?: string;
      additionalProperties?: boolean;
    };
    const schema = compileResultJsonSchema as unknown as Node;
    const rule = schema.anyOf?.find((branch) => branch.properties?.type?.enum?.includes('rule_proposal'));
    const variants = rule?.properties?.oldRequirements?.items?.anyOf ?? [];
    const kinds = variants.flatMap((variant) => variant.properties?.type?.enum ?? []);
    expect(kinds).toEqual(expect.arrayContaining(['collectBeforeGoal', 'passThrough', 'switchNecessary']));
    expect(variants.every((variant) => variant.type === 'object' && variant.additionalProperties === false)).toBe(true);

    const patch = schema.anyOf?.find((branch) => branch.properties?.type?.enum?.includes('patch'));
    const operations = patch?.properties?.operations?.items?.anyOf ?? [];
    const addItem = operations.find((operation) => operation.properties?.kind?.enum?.includes('addItem'));
    expect(rule).toBeDefined();
    expect(addItem?.type).toBe('object');
  });
});
