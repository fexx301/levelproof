#!/usr/bin/env node
/**
 * Visual QA for the procedural scenery kit: prints two share links whose
 * levels place every prop kind (plus a torch-look key and water/lava tiles)
 * around a tiny verified walkway. Open them against a running dev server.
 *
 * Usage: npx tsx scripts/prop-gallery.ts [environment] [lighting] [origin]
 */
import { encodeLevelShare } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import { environmentSchema, lightingSchema, PROP_KINDS, type Level } from '../shared/schema';

const environment = environmentSchema.parse(process.argv[2] ?? 'meadow');
const lighting = lightingSchema.parse(process.argv[3] ?? 'day');
const origin = process.argv[4] ?? 'http://127.0.0.1:5173';
const kinds = PROP_KINDS.filter((kind) => kind !== 'water' && kind !== 'lava');

for (const half of [kinds.slice(0, 14), kinds.slice(14)]) {
  const level: Level = {
    modules: [
      { id: 'start', template: 'flat', x: 7, z: 9, h: 0, ports: ['N'] },
      { id: 'mid', template: 'flat', x: 7, z: 8, h: 0, ports: ['N', 'S'] },
      { id: 'end', template: 'flat', x: 7, z: 7, h: 0, ports: ['S'] },
    ],
    keys: [{ id: 'torch', moduleId: 'mid', look: 'torch' }],
    switches: [],
    doors: [],
    requirements: [],
    spawn: 'start',
    goal: 'end',
    scenery: { environment, lighting, architecture: 'limestone' },
    props: [
      ...half.map((prop, index) => ({ id: `prop-${index}`, prop, x: 4 + (index % 7), z: index < 7 ? 5 : 11 })),
      { id: 'water-tile', prop: 'water' as const, x: 8, z: 9 },
      { id: 'lava-tile', prop: 'lava' as const, x: 8, z: 8 },
    ],
  };
  const report = verify(level);
  if (!report.accepted) throw new Error(`Gallery level is not accepted: ${report.invalidReasons.join('; ')}`);
  console.log(`${origin}/?p=${encodeLevelShare(level)}`);
}
