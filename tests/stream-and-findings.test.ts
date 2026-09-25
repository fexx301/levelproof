import { describe, expect, it } from 'vitest';
import { normalizeWirePayload } from '../shared/compile-result';
import { OperationStream, operationLabel, reasoningHeadlines } from '../shared/stream-progress';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { trapLevel } from '../src/core/fixtures/trap';
import { engineFindings } from '../src/core/engine-findings';
import { applyOperations } from '../src/core/level';
import { verify } from '../src/core/verifier';

describe('streamed operation parsing', () => {
  it('yields each operation once its object closes, across arbitrary chunk splits', () => {
    const payload = JSON.stringify({
      type: 'patch',
      rationale: 'Braces { in } prose and "quotes" must not confuse the scanner.',
      assumptions: [],
      operations: [
        { kind: 'addModule', module: { id: 'hall', template: 'flat', x: 1, z: 1, h: 0, label: 'great {hall}', ports: ['N'] } },
        { kind: 'addProp', id: 'guardian', prop: 'dragon', x: 2, z: 2 },
        { kind: 'setScenery', environment: 'forest', lighting: 'night' },
      ],
    });
    const stream = new OperationStream();
    const found: unknown[] = [];
    for (let i = 0; i < payload.length; i += 7) found.push(...stream.push(payload.slice(i, i + 7)));
    expect(found).toHaveLength(3);
    expect(found.map(operationLabel)).toEqual([
      '+ flat: great {hall}',
      '✦ dragon: guardian',
      '✦ scenery: forest, night',
    ]);
  });

  it('reads the bold headlines of a reasoning summary without repeats', () => {
    expect(reasoningHeadlines('**Planning the Keep**\nText **Placing the Key** more **Planning the Keep**')).toEqual([
      'Planning the Keep',
      'Placing the Key',
    ]);
  });
});

describe('cosmetic vocabulary normalization', () => {
  it('maps near-miss scenery words and drops unknown decorations, never gameplay', () => {
    const normalized = normalizeWirePayload(JSON.stringify({
      type: 'patch',
      rationale: 'r',
      assumptions: [],
      operations: [
        { kind: 'addItem', itemType: 'key', id: 'lamp-key', moduleId: 'start-walk', look: 'Crystal' },
        { kind: 'addProp', id: 'street-lamp', prop: 'lamp', x: 1, z: 1 },
        { kind: 'addProp', id: 'spaceship', prop: 'spaceship', x: 2, z: 1 },
        { kind: 'setScenery', environment: 'jungle', lighting: 'sunset', architecture: 'gothic' },
        { kind: 'moveGoal', moduleId: 'start-walk' },
      ],
    })) as { operations: Array<Record<string, unknown>> };
    expect(normalized.operations).toEqual([
      { kind: 'addItem', itemType: 'key', id: 'lamp-key', moduleId: 'start-walk', look: 'gem' },
      { kind: 'addProp', id: 'street-lamp', prop: 'lantern', x: 1, z: 1 },
      { kind: 'setScenery', environment: 'forest', lighting: 'dusk' },
      { kind: 'moveGoal', moduleId: 'start-walk' },
    ]);
  });
});

describe('engine findings for the AI↔engine loop', () => {
  it('explains an unwinnable build concretely: the key is behind its own door', () => {
    const applied = applyOperations(blankCanvasLevel, [
      { kind: 'addModule', module: { id: 'side-room', template: 'flat', x: 6, z: 7, h: 0, ports: ['E'] } },
      { kind: 'setModulePorts', id: 'start-walk', ports: ['N', 'S', 'W'] },
      { kind: 'addItem', itemType: 'key', id: 'vault-key', moduleId: 'side-room' },
      { kind: 'addDoor', door: { id: 'side-door', a: 'start-walk', b: 'side-room', conditions: { requiresKey: 'vault-key' } } },
      { kind: 'addDoor', door: { id: 'vault-door', a: 'start-walk', b: 'goal-pad', conditions: { requiresKey: 'vault-key' } } },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const findings = engineFindings(applied.level, verify(applied.level));
    expect(findings[0]).toMatch(/^The level cannot be won/);
    expect(findings.join('\n')).toContain('Door "side-door"');
    expect(findings.join('\n')).toContain('requires key "vault-key" (on "side-room", which is unreachable)');
  });

  it('names the stranding switch for a trap', () => {
    const findings = engineFindings(trapLevel, verify(trapLevel));
    expect(findings[0]).toMatch(/^A player can get stuck: At move \d+, activating “seal-switch” closes “gallery-door”/);
    expect(findings[1]).toMatch(/^Route that strands the player: entrance → /);
  });

  it('has nothing to say about a passing level', () => {
    expect(engineFindings(blankCanvasLevel, verify(blankCanvasLevel))).toEqual([]);
  });
});
