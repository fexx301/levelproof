import { CARDINALS, type Level, type LevelModule } from '../../shared/schema';
import { CATALOG_VERSION } from './catalog';

/**
 * Canonical ordering and revision identity (§3, §11). Entity order never
 * changes the revision id; content does. Internal identity only — there is
 * no user-facing JSON export.
 */

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function canonicalModule(m: LevelModule) {
  const ports = [...m.ports].sort((a, b) => CARDINALS.indexOf(a) - CARDINALS.indexOf(b));
  return {
    id: m.id,
    template: m.template,
    x: m.x,
    z: m.z,
    h: m.h,
    ...(m.orientation !== undefined ? { orientation: m.orientation } : {}),
    ...(m.label !== undefined ? { label: m.label } : {}),
    ports,
  };
}

export function canonicalJson(level: Level): string {
  const modules = [...level.modules].sort(byId).map(canonicalModule);
  const keys = [...level.keys].sort(byId).map((k) => ({ id: k.id, moduleId: k.moduleId }));
  const switches = [...level.switches].sort(byId).map((s) => ({ id: s.id, moduleId: s.moduleId }));
  const doors = [...level.doors]
    .sort(byId)
    .map((d) => ({ id: d.id, a: d.a, b: d.b, conditions: d.conditions ?? {} }));
  const requirements = [...level.requirements]
    .sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    .map((r) => ({ type: r.type, keyId: r.keyId }));
  return JSON.stringify({
    catalogVersion: CATALOG_VERSION,
    modules,
    keys,
    switches,
    spawn: level.spawn,
    goal: level.goal,
    doors,
    requirements,
  });
}

/** FNV-1a 32-bit, hex-encoded. Dependency-free deterministic hashing. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Stable revision identity for a level: canonical content + catalog version. */
export function revisionId(level: Level): string {
  return `rev-${fnv1a32(canonicalJson(level))}`;
}
