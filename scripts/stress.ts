/**
 * Stress measurement (§17 recorded bounds): verify() and findRepairs()
 * timing on generated layouts from the golden fixture up to the state-space
 * bound (256 modules × 3 keys × 4 switches = 32,768 states). Run with tsx.
 */
import { verify } from '../src/core/verifier';
import { findRepairs } from '../src/core/search';
import type { Level, LevelModule } from '../shared/schema';

function gridLevel(size: number): Level {
  const modules: LevelModule[] = [];
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const ports: Array<'N' | 'E' | 'S' | 'W'> = [];
      if (z > 0) ports.push('N');
      if (z < size - 1) ports.push('S');
      if (x > 0) ports.push('W');
      if (x < size - 1) ports.push('E');
      modules.push({ id: `cell-${x}-${z}`, template: 'flat', x, z, h: 0, ports });
    }
  }
  const at = (x: number, z: number): string => `cell-${x}-${z}`;
  return {
    modules,
    keys: [
      { id: 'k1', moduleId: at(1, 1) },
      { id: 'k2', moduleId: at(size - 2, 1) },
      { id: 'k3', moduleId: at(1, size - 2) },
    ],
    switches: [
      { id: 's1', moduleId: at(2, 2) },
      { id: 's2', moduleId: at(size - 3, 2) },
      { id: 's3', moduleId: at(2, size - 3) },
      { id: 's4', moduleId: at(size - 3, size - 3) },
    ],
    spawn: at(0, 0),
    goal: at(size - 1, size - 1),
    doors: [],
    requirements: [],
  };
}

const sizes = [6, 9, 12, 16];
console.log('grid  modules  states  verify-ms  accepted');
for (const size of sizes) {
  const level = gridLevel(size);
  const t0 = performance.now();
  const report = verify(level);
  if (report.invalidReasons.length > 0) console.log('  invalid:', report.invalidReasons.slice(0, 3).join(' | '));
  const ms = performance.now() - t0;
  console.log(
    `${String(size).padStart(4)}x${String(size).padEnd(3)} ${String(level.modules.length).padStart(7)} ${String(report.exploredCount).padStart(7)} ${ms.toFixed(1).padStart(9)}  ${report.accepted}`,
  );
}

// Repair search: the golden trap fixture — the demo's worst real case
// (recovery fail, each candidate fully re-verified).
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';
const trapReport = verify(trapLevel);
if (trapReport.invalidReasons.length > 0) console.log('trap invalid:', trapReport.invalidReasons.slice(0, 2).join(' | '));
const t0 = performance.now();
const repairs = findRepairs(baselineLevel, trapLevel, trapReport);
const ms = performance.now() - t0;
console.log(
  `\nrepair search on the trap fixture (${trapReport.exploredCount} states, recovery=${trapReport.checks.recovery.status}): ${ms.toFixed(1)} ms, ${repairs.candidates.length} candidates`,
);
