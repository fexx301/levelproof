import { CARDINALS, levelSchema, type Level, type LevelModule } from '../../shared/schema.js';
import { CATALOG_VERSION } from './catalog.js';

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

/**
 * Share links (§12 saving/sharing): a level as schema-exact JSON (no
 * catalogVersion — levelSchema is strict and rejects unknown fields),
 * base64url-encoded for a URL parameter. The payload is schema-validated on
 * decode, so a tampered or truncated link can never inject an invalid scene;
 * it simply falls back to the default.
 */
export function encodeLevelShare(level: Level): string {
  const json = JSON.stringify({
    modules: [...level.modules].sort(byId).map(canonicalModule),
    keys: [...level.keys].sort(byId).map((k) => ({ id: k.id, moduleId: k.moduleId })),
    switches: [...level.switches].sort(byId).map((sw) => ({ id: sw.id, moduleId: sw.moduleId })),
    spawn: level.spawn,
    goal: level.goal,
    doors: [...level.doors]
      .sort(byId)
      .map((d) => ({ id: d.id, a: d.a, b: d.b, ...(d.conditions !== undefined ? { conditions: d.conditions } : {}) })),
    requirements: [...level.requirements]
      .sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
      .map((r) => ({ type: r.type, keyId: r.keyId })),
  });
  const b64 =
    typeof btoa === 'function' ? b64UrlEncodeBrowser(json) : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlEncodeBrowser(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64UrlDecode(payload: string): string {
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4);
  if (typeof atob !== 'function') return Buffer.from(padded, 'base64').toString('utf8');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function decodeLevelShare(payload: string): Level | null {
  if (payload.length === 0 || payload.length > 100_000) return null;
  try {
    const parsed = levelSchema.safeParse(JSON.parse(b64UrlDecode(payload)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
