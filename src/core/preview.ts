import type { Operation, Level } from '../../shared/schema.js';

/** One discriminated preview payload; the renderer never has to reconcile
 * independent operations and candidate inputs. */
export interface PreviewState {
  source: 'ai' | 'repair';
  baseRevision: string;
  before: Level;
  candidate: Level;
  operations: Operation[];
}
