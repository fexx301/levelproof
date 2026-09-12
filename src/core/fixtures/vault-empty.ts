import type { Level } from '../../../shared/schema';
import { baselineLevel } from './baseline';

/**
 * The Balcony Vault with geometry, spawn, and goal only (§8): the starting
 * material for prompt 1. A seeded scene, not a canned answer.
 */
export const vaultEmptyLevel: Level = {
  ...baselineLevel,
  keys: [],
  switches: [],
  doors: [],
  requirements: [],
};
