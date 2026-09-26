import type { Report } from './verifier.js';

/** Fewer failing checks is better; an unwinnable level is worst. Used to pick
 * between an AI build and its engine-guided revisions. */
export function reportScore(report: Report): number {
  if (!report.valid) return 100;
  return (report.checks.solution.status === 'fail' ? 10 : 0) +
    (report.checks.requirements.status === 'fail' ? 3 : 0) +
    (report.checks.recovery.status === 'fail' ? 2 : 0) +
    (report.complete ? 0 : 1);
}
