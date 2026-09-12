import type { Cardinal, LevelModule } from '../../shared/schema.js';

/**
 * Versioned kit catalog (§4.1). All geometry in integer centimeters.
 * Initial scale to validate in the spike: 400 cm cell pitch, 300 cm floor
 * spacing, 160 cm player height, 25 cm player radius.
 */
export const CATALOG_VERSION = 'catalog-1.0.0';

export const GEOMETRY = {
  cellPitchCm: 400,
  floorSpacingCm: 300,
  floorSlabThicknessCm: 30,
  playerHeightCm: 160,
  playerRadiusCm: 25,
  portWidthCm: 120,
} as const;

/** Static catalog invariants (asserted in tests; failures are catalog bugs). */
export const CATALOG_INVARIANTS = {
  portClearsPlayer: GEOMETRY.portWidthCm >= 2 * GEOMETRY.playerRadiusCm,
  floorSpacingClearsPlayer:
    GEOMETRY.floorSpacingCm - GEOMETRY.floorSlabThicknessCm >= GEOMETRY.playerHeightCm,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Compass convention: N = -z, S = +z, E = +x, W = -x. */
export function opposite(dir: Cardinal): Cardinal {
  switch (dir) {
    case 'N':
      return 'S';
    case 'S':
      return 'N';
    case 'E':
      return 'W';
    case 'W':
      return 'E';
  }
}

export function dirDelta(dir: Cardinal): { dx: number; dz: number } {
  switch (dir) {
    case 'N':
      return { dx: 0, dz: -1 };
    case 'S':
      return { dx: 0, dz: 1 };
    case 'E':
      return { dx: 1, dz: 0 };
    case 'W':
      return { dx: -1, dz: 0 };
  }
}

/**
 * Walking-surface elevation (floor index) at a module's port, or null when
 * that side is closed or the module is malformed. Ramp ends sit at different
 * elevations: the low end at h, the high end (orientation side) at h+1.
 */
export function portElevation(m: LevelModule, dir: Cardinal): number | null {
  if (!m.ports.includes(dir)) return null;
  switch (m.template) {
    case 'flat':
    case 'bridge':
      return m.h;
    case 'ramp': {
      const high = m.orientation;
      if (high === undefined) return null;
      if (dir === high) return m.h + 1;
      if (dir === opposite(high)) return m.h;
      return null;
    }
  }
}

/** Module center on its walking surface. A ramp's center is mid-slope. */
export function centerPoint(m: LevelModule): Vec3 {
  const cx = m.x * GEOMETRY.cellPitchCm + GEOMETRY.cellPitchCm / 2;
  const cz = m.z * GEOMETRY.cellPitchCm + GEOMETRY.cellPitchCm / 2;
  const y =
    m.template === 'ramp'
      ? m.h * GEOMETRY.floorSpacingCm + GEOMETRY.floorSpacingCm / 2
      : m.h * GEOMETRY.floorSpacingCm;
  return { x: cx, y, z: cz };
}

/** Midpoint of the shared boundary at a module's open port. */
export function portPoint(m: LevelModule, dir: Cardinal): Vec3 {
  const elevation = portElevation(m, dir);
  if (elevation === null) throw new Error(`port ${dir} is not open on module "${m.id}"`);
  const c = centerPoint(m);
  const half = GEOMETRY.cellPitchCm / 2;
  const { dx, dz } = dirDelta(dir);
  return { x: c.x + dx * half, y: elevation * GEOMETRY.floorSpacingCm, z: c.z + dz * half };
}

/**
 * Catalog-owned movement polyline for one edge traversal: source center,
 * shared port midpoint, destination center (§4.2). The renderer interpolates
 * along these segments; it never decides legality.
 */
export function traversalSegments(a: LevelModule, dir: Cardinal, b: LevelModule): Vec3[] {
  return [centerPoint(a), portPoint(a, dir), centerPoint(b)];
}

/**
 * Conservative vertical span [bottomY, topY] of a module's solid volume.
 * A ramp is treated as occupying its full cell from low floor to high floor;
 * conservative volumes may reject tight arrangements (§4.2).
 */
export function verticalSpan(m: LevelModule): readonly [number, number] {
  const base = m.h * GEOMETRY.floorSpacingCm;
  switch (m.template) {
    case 'flat':
    case 'bridge':
      return [base - GEOMETRY.floorSlabThicknessCm, base];
    case 'ramp':
      return [base - GEOMETRY.floorSlabThicknessCm, base + GEOMETRY.floorSpacingCm];
  }
}
