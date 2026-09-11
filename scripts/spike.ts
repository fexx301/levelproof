/**
 * Spike measurement harness (§7.1). Prints explored-state counts and wall
 * time for the golden fixtures, and will carry the stress-layout
 * measurements front-loaded into spike week (near-limit layouts: max
 * modules, 3 keys, 4 switches). Run: npx tsx scripts/spike.ts
 */
import type { Level } from '../shared/schema';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';
import { verify } from '../src/core/verifier';

function measure(label: string, level: Level): void {
  const t0 = performance.now();
  const report = verify(level);
  const ms = performance.now() - t0;
  console.log(
    `${label}: valid=${report.valid} accepted=${report.accepted} explored=${report.exploredCount} complete=${report.complete} ${ms.toFixed(1)} ms`,
  );
}

measure('baseline', baselineLevel);
measure('trap', trapLevel);
