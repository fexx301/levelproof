import type { CompiledLevel } from '../core/topology.js';

/** Presentation only: no theme field enters the level schema or verifier. */
export interface ArtDirection {
  name: string;
  floor: number;
  wall: number;
  metal: number;
  trim: number;
  base: number;
  sky: number;
  light: number;
  camera: [number, number, number];
}

const directions: Record<string, ArtDirection> = {
  limestone: { name: 'Limestone vault', floor: 0xc4b99e, wall: 0x8c826b, metal: 0x5d6b68, trim: 0xdbceb0, base: 0x252b2d, sky: 0xc9d7dc, light: 0xffe0b0, camera: [2.7, 3.6, 3.9] },
  ivory: { name: 'Ivory observatory', floor: 0xd1cbb9, wall: 0x969c97, metal: 0x657979, trim: 0xe8dfc5, base: 0x242d32, sky: 0xd9e6eb, light: 0xffe8c8, camera: [4.5, 4.5, 2] },
  patina: { name: 'Patinated relay works', floor: 0xa8b3a5, wall: 0x647f7d, metal: 0x426766, trim: 0xbab692, base: 0x202e2f, sky: 0xccdce0, light: 0xffdfae, camera: [3.8, 4.4, 3.2] },
  basalt: { name: 'Basalt lockhouse', floor: 0x9b9b9a, wall: 0x606c78, metal: 0x414d5c, trim: 0xbba68a, base: 0x222831, sky: 0xcbd8ed, light: 0xffd3a0, camera: [3, 4.2, 3.8] },
  // Scene-derived aliases (gallery scenes pick their identity by module).
  vault: { name: 'Limestone vault', floor: 0xc4b99e, wall: 0x8c826b, metal: 0x5d6b68, trim: 0xdbceb0, base: 0x252b2d, sky: 0xc9d7dc, light: 0xffe0b0, camera: [2.7, 3.6, 3.9] },
  twins: { name: 'Ivory observatory', floor: 0xd1cbb9, wall: 0x969c97, metal: 0x657979, trim: 0xe8dfc5, base: 0x242d32, sky: 0xd9e6eb, light: 0xffe8c8, camera: [4.5, 4.5, 2] },
  overpass: { name: 'Patinated relay works', floor: 0xa8b3a5, wall: 0x647f7d, metal: 0x426766, trim: 0xbab692, base: 0x202e2f, sky: 0xccdce0, light: 0xffdfae, camera: [3.8, 4.4, 3.2] },
  gauntlet: { name: 'Basalt lockhouse', floor: 0x9b9b9a, wall: 0x606c78, metal: 0x414d5c, trim: 0xbba68a, base: 0x222831, sky: 0xcbd8ed, light: 0xffd3a0, camera: [3, 4.2, 3.8] },
};

export type ThemeKey = 'limestone' | 'ivory' | 'patina' | 'basalt';

/** The author's chosen theme overrides the scene-derived default. */
export function artDirection(compiled: CompiledLevel, theme?: ThemeKey): ArtDirection {
  if (theme !== undefined) return directions[theme]!;
  if (compiled.moduleById.has('grand-gallery')) return directions.twins!;
  if (compiled.moduleById.has('under-passage')) return directions.overpass!;
  if (compiled.moduleById.has('gauntlet-ramp')) return directions.gauntlet!;
  return directions.vault!;
}

/** Opening a gate and sealing a route have distinct shape AND color cues. */
export function switchSignature(compiled: CompiledLevel, id: string) {
  const seals = compiled.level.doors.some(door => door.conditions?.closesAfterSwitch === id);
  return seals ? { color: 0xbf6651, sides: 3 } : { color: 0x73b5c3, sides: 6 };
}
