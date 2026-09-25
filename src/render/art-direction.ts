import type { CompiledLevel } from '../core/topology.js';
import type { Environment, ThemeKey } from '../../shared/schema.js';

export type { ThemeKey } from '../../shared/schema.js';

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

const themeDirections: Record<ThemeKey, ArtDirection> = {
  limestone: { name: 'Limestone vault', floor: 0xc4b99e, wall: 0x8c826b, metal: 0x5d6b68, trim: 0xdbceb0, base: 0x252b2d, sky: 0xc9d7dc, light: 0xffe0b0, camera: [2.7, 3.6, 3.9] },
  ivory: { name: 'Ivory observatory', floor: 0xd1cbb9, wall: 0x969c97, metal: 0x657979, trim: 0xe8dfc5, base: 0x242d32, sky: 0xd9e6eb, light: 0xffe8c8, camera: [4.5, 4.5, 2] },
  patina: { name: 'Patinated relay works', floor: 0xa8b3a5, wall: 0x647f7d, metal: 0x426766, trim: 0xbab692, base: 0x202e2f, sky: 0xccdce0, light: 0xffdfae, camera: [3.8, 4.4, 3.2] },
  basalt: { name: 'Basalt lockhouse', floor: 0x9b9b9a, wall: 0x606c78, metal: 0x414d5c, trim: 0xbba68a, base: 0x222831, sky: 0xcbd8ed, light: 0xffd3a0, camera: [3, 4.2, 3.8] },
  futuristic: { name: 'Future vault', floor: 0x71818a, wall: 0x27343e, metal: 0x4c8195, trim: 0x9fd9dd, base: 0x101820, sky: 0x9ebdc5, light: 0xd1f5ff, camera: [3.4, 4.3, 3.3] },
};

// Scene-derived aliases (gallery scenes pick their identity by module).
const sceneDirections: Record<'vault' | 'twins' | 'overpass' | 'gauntlet', ArtDirection> = {
  vault: themeDirections.limestone,
  twins: themeDirections.ivory,
  overpass: themeDirections.patina,
  gauntlet: themeDirections.basalt,
};

/** A sensible building material when the scenery names a world but no architecture. */
const environmentArchitecture: Partial<Record<Environment, ThemeKey>> = {
  snow: 'ivory',
  volcanic: 'basalt',
  cavern: 'basalt',
  swamp: 'patina',
  sea: 'patina',
  desert: 'limestone',
  meadow: 'limestone',
  forest: 'limestone',
  space: 'futuristic',
  city: 'futuristic',
};

/** The resolved architecture: the author's editor override, then the scene's
 * own scenery, then a scene-derived default. */
export function resolvedArchitecture(compiled: CompiledLevel, theme?: ThemeKey): ThemeKey | undefined {
  if (theme !== undefined) return theme;
  const scenery = compiled.level.scenery;
  if (scenery?.architecture !== undefined) return scenery.architecture;
  if (scenery?.environment !== undefined) return environmentArchitecture[scenery.environment];
  return undefined;
}

/** The author's chosen theme overrides the scene-derived default. */
export function artDirection(compiled: CompiledLevel, theme?: ThemeKey): ArtDirection {
  const resolved = resolvedArchitecture(compiled, theme);
  if (resolved !== undefined) return themeDirections[resolved];
  if (compiled.moduleById.has('grand-gallery')) return sceneDirections.twins;
  if (compiled.moduleById.has('under-passage')) return sceneDirections.overpass;
  if (compiled.moduleById.has('gauntlet-ramp')) return sceneDirections.gauntlet;
  return sceneDirections.vault;
}

/** Opening a gate and sealing a route have distinct shape AND color cues. */
export function switchSignature(compiled: CompiledLevel, id: string) {
  const seals = compiled.level.doors.some(door => door.conditions?.closesAfterSwitch === id);
  return seals ? { color: 0xbf6651, sides: 3 } : { color: 0x73b5c3, sides: 6 };
}
