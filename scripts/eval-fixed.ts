#!/usr/bin/env node
import { fixedEvaluationSummary } from '../src/core/evaluation-suite.js';

const summary = fixedEvaluationSummary();

console.log(`Deterministic LevelProof evaluation: ${summary.passed}/${summary.total} cases passed.`);
for (const [category, result] of Object.entries(summary.byCategory)) {
  console.log(`  ${category}: ${result.passed}/${result.total}`);
}

const failures = summary.results.filter((result) => !result.semanticFulfillment);
if (failures.length > 0) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  ${failure.id}: ${failure.errors.join('; ')}`);
  process.exitCode = 1;
}
