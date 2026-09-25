import type { Level, Operation } from '../../shared/schema.js';
import { verify } from './verifier.js';

const REMOVAL_KINDS = new Set<Operation['kind']>(['removeModule', 'removeItem', 'removeDoor', 'removeProp']);

/**
 * An additive build that cannot be won is almost never what the author
 * meant, so it gets one automatic AI↔engine revision. Edits that remove
 * things are shown exactly as asked: breaking a level can be the point.
 * Shared by the editor, the chip battery, and the prewarm script so all three
 * send identical revision requests.
 */
export function shouldAutoRevise(base: Level, candidate: Level, operations: Operation[]): boolean {
  if (operations.length === 0 || operations.some((operation) => REMOVAL_KINDS.has(operation.kind))) return false;
  const before = verify(base);
  const after = verify(candidate);
  return after.valid && after.complete && after.checks.solution.status === 'fail' && before.checks.solution.status !== 'fail';
}
