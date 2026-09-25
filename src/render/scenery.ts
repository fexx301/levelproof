import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUND_TILE_PROPS, type Environment, type Level, type Lighting, type Prop } from '../../shared/schema.js';
import { GEOMETRY, centerPoint } from '../core/catalog.js';
import { buildProp, hashString, MaterialCache, seededRandom, type BuiltProp, type PropContext, type ScatterKind } from './props.js';

/**
 * World dressing around the verified diorama (cosmetic only): terrain, sky,
 * fog, scattered vegetation, particles, and the author's landmark props.
 * Nothing here is pickable except landmark props, and nothing here is read by
 * the engine — the floors the checker explores are exactly the modules.
 */

/** Top of the terrain: just under the foundation blocks, so ground-level
 * floors read as raised stone paths on the land. */
export const GROUND_Y = -62;

export interface Atmosphere {
  environment: Environment;
  lighting: Lighting;
  skyTop: number;
  horizon: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  /** 0 = on the horizon, 1 = overhead. */
  sunElevation: number;
  fillColor: number;
  fillIntensity: number;
  exposure: number;
  /** Fog far distance as a multiple of the framed camera distance. */
  fogReach: number;
}

const LIGHTING_BASE: Record<Lighting, Omit<Atmosphere, 'environment' | 'lighting' | 'fogReach'>> = {
  day: {
    skyTop: 0x6f93b0, horizon: 0xc6d3da, hemiSky: 0xd8e4ee, hemiGround: 0x82715e, hemiIntensity: 1.4,
    sunColor: 0xffecd1, sunIntensity: 2.4, sunElevation: 0.82, fillColor: 0xbad3ed, fillIntensity: 0.8, exposure: 1.05,
  },
  dusk: {
    // Warm low sun, but a neutral sky fill so the floors keep their material.
    skyTop: 0x2f3860, horizon: 0xe3a27a, hemiSky: 0xd9d2e0, hemiGround: 0x6a5648, hemiIntensity: 1.25,
    sunColor: 0xffc38e, sunIntensity: 2.2, sunElevation: 0.36, fillColor: 0x9ea6d8, fillIntensity: 0.6, exposure: 1.05,
  },
  night: {
    // Moonlit rather than black: the puzzle must stay readable at night.
    skyTop: 0x040711, horizon: 0x1d2a4a, hemiSky: 0x8fa6dc, hemiGround: 0x262634, hemiIntensity: 0.95,
    sunColor: 0xc0d2ff, sunIntensity: 1.25, sunElevation: 0.62, fillColor: 0x5a6ea8, fillIntensity: 0.5, exposure: 1.2,
  },
};

const ENVIRONMENT_HAZE: Record<Environment, number> = {
  void: 0x101216,
  meadow: 0xcbd8bc,
  forest: 0x93ab93,
  swamp: 0x77846a,
  desert: 0xe2c794,
  snow: 0xe6edf4,
  volcanic: 0x8a4636,
  cavern: 0x2a2522,
  sea: 0xa6c8da,
  space: 0x0a0c1c,
  city: 0x878aa4,
};

const GROUND_COLOR: Record<Environment, number | null> = {
  void: null,
  meadow: 0x5d7a43,
  forest: 0x3d5635,
  swamp: 0x3c4634,
  desert: 0xc8a674,
  snow: 0xe4ebf1,
  volcanic: 0x3b302b,
  cavern: 0x3a3330,
  sea: null,
  space: null,
  city: 0x3a3e46,
};

function mix(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

export function atmosphere(environment: Environment, lighting: Lighting): Atmosphere {
  const base = LIGHTING_BASE[lighting];
  const haze = ENVIRONMENT_HAZE[environment];
  const weight = lighting === 'day' ? 0.55 : lighting === 'dusk' ? 0.3 : 0.18;
  const result: Atmosphere = {
    ...base,
    environment,
    lighting,
    horizon: mix(base.horizon, haze, weight),
    fogReach: environment === 'swamp' ? 2.4 : environment === 'forest' ? 3.0 : 3.8,
  };
  if (environment === 'cavern') {
    result.skyTop = 0x0e0b0a;
    result.horizon = mix(0x2a2522, base.horizon, 0.15);
    result.hemiIntensity *= 0.75;
    result.sunIntensity *= 0.55;
  }
  if (environment === 'space') {
    result.skyTop = 0x010208;
    result.horizon = 0x0c1026;
    result.hemiSky = 0xa8b8e0;
  }
  if (environment === 'volcanic') result.hemiGround = mix(result.hemiGround, 0xa03a1a, 0.5);
  if (environment === 'snow' && lighting === 'day') result.exposure = 0.95;
  return result;
}

interface ScatterTable {
  tall: Array<[ScatterKind, number]>;
  low: Array<[ScatterKind, number]>;
}

const SCATTER: Record<Environment, ScatterTable> = {
  void: { tall: [], low: [] },
  meadow: { tall: [['tree', 3], ['pine', 1]], low: [['bush', 3], ['rock', 2], ['flowers', 4]] },
  forest: { tall: [['pine', 4], ['tree', 3]], low: [['bush', 3], ['rock', 2], ['mushroom', 2]] },
  swamp: { tall: [['dead-tree', 4], ['tree', 1]], low: [['reeds', 4], ['pond', 3], ['mushroom', 2], ['rock', 1]] },
  desert: { tall: [['cactus', 3], ['palm', 1]], low: [['rock', 4]] },
  snow: { tall: [['snow-pine', 5]], low: [['rock', 3], ['crystal', 1]] },
  volcanic: { tall: [['stalagmite', 2]], low: [['lava-pool', 3], ['rock', 4], ['crystal', 1]] },
  cavern: { tall: [['stalagmite', 5]], low: [['crystal', 2], ['mushroom', 3], ['rock', 2]] },
  sea: { tall: [], low: [['rock', 1]] },
  space: { tall: [], low: [] },
  city: { tall: [['building', 6], ['antenna', 1]], low: [['barrel', 1]] },
};

function pick(table: Array<[ScatterKind, number]>, random: () => number): ScatterKind | null {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === 0) return null;
  let roll = random() * total;
  for (const [kind, weight] of table) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return table.at(-1)?.[0] ?? null;
}

export interface SceneryOptions {
  environment: Environment;
  lighting: Lighting;
  accent: number;
  stone: number;
  /** Horizontal direction toward the camera (world x, z), for keeping tall
   * scatter off the side the author looks from. */
  cameraSide: { x: number; z: number };
  reduced: () => boolean;
}

export interface LandmarkPlacement {
  id: string;
  object: THREE.Group;
  /** Ground-level world position of the prop's base. */
  base: THREE.Vector3;
  /** Flat water or lava tile: receives light but casts no shadow. */
  tile: boolean;
}

export interface SceneryBuild {
  /** Terrain, scatter, sky, particles: never pickable. */
  environmentRoot: THREE.Group;
  /** Author-placed props: pickable by id. */
  landmarks: LandmarkPlacement[];
  lights: THREE.PointLight[];
  update: (dt: number, elapsed: number) => void;
  /** Fit fog to the framed camera distance. */
  setFogRange: (fitDistance: number) => void;
  /** Adaptive quality: drop the costliest cosmetic effects on slow devices. */
  reduceDetail: () => void;
  fog: THREE.Fog | null;
  dispose: () => void;
}

const CELL = GEOMETRY.cellPitchCm;

function cellCenter(x: number, z: number): { x: number; z: number } {
  return { x: x * CELL + CELL / 2, z: z * CELL + CELL / 2 };
}

/** Surface height and host module for a landmark prop on cell (x, z). */
function landmarkHost(level: Level, prop: Prop): { y: number; onModule: boolean } {
  if (GROUND_TILE_PROPS.has(prop.prop)) return { y: GROUND_Y, onModule: false };
  const host = level.modules
    .filter((module) => module.x === prop.x && module.z === prop.z)
    .sort((a, b) => b.h - a.h)[0];
  if (host === undefined) return { y: GROUND_Y, onModule: false };
  return { y: centerPoint(host).y, onModule: true };
}

function skyDome(top: number, horizon: number, radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const colors: number[] = [];
  const position = geometry.getAttribute('position');
  const topColor = new THREE.Color(top);
  const horizonColor = new THREE.Color(horizon);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const t = Math.max(0, position.getY(i) / radius);
    color.copy(horizonColor).lerp(topColor, Math.pow(t, 0.55));
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const dome = new THREE.Mesh(geometry, material);
  dome.renderOrder = -1;
  return dome;
}

function starfield(radius: number, count: number, random: () => number): THREE.Points {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(random() * 0.95);
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
}

type ParticleKind = 'fireflies' | 'snow' | 'embers' | 'dust';

function particleKind(environment: Environment, lighting: Lighting): ParticleKind | null {
  if (environment === 'snow') return 'snow';
  if (environment === 'volcanic') return 'embers';
  if (environment === 'cavern') return 'fireflies';
  if ((environment === 'forest' || environment === 'swamp' || environment === 'meadow') && lighting === 'night') return 'fireflies';
  if (environment === 'desert' || environment === 'forest') return 'dust';
  return null;
}

/** Soft round sprite so particles read as motes, snowflakes, and sparks. */
function softDot(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function particles(kind: ParticleKind, bounds: THREE.Box3, random: () => number): { points: THREE.Points; update: (dt: number, elapsed: number) => void } {
  const count = kind === 'snow' ? 360 : kind === 'embers' ? 140 : kind === 'fireflies' ? 60 : 70;
  const min = bounds.min.clone().addScalar(-900);
  const max = bounds.max.clone().addScalar(900);
  min.y = GROUND_Y;
  max.y = bounds.max.y + (kind === 'snow' ? 1600 : 700);
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = min.x + random() * (max.x - min.x);
    positions[i * 3 + 1] = min.y + random() * (max.y - min.y);
    positions[i * 3 + 2] = min.z + random() * (max.z - min.z);
    phases[i] = random() * Math.PI * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const style = {
    snow: { color: 0xffffff, size: 18, opacity: 0.85, additive: false },
    embers: { color: 0xff8a3a, size: 16, opacity: 0.95, additive: true },
    fireflies: { color: 0xe8f59a, size: 24, opacity: 0.95, additive: true },
    dust: { color: 0xf2e6c8, size: 10, opacity: 0.35, additive: false },
  }[kind];
  const sprite = softDot();
  const material = new THREE.PointsMaterial({
    color: style.color,
    size: style.size,
    transparent: true,
    opacity: style.opacity,
    depthWrite: false,
    ...(sprite !== null ? { map: sprite, alphaTest: 0.01 } : {}),
    ...(style.additive ? { blending: THREE.AdditiveBlending } : {}),
  });
  const points = new THREE.Points(geometry, material);
  const update = (dt: number, elapsed: number): void => {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const phase = phases[i]!;
      let x = attribute.getX(i);
      let y = attribute.getY(i);
      let z = attribute.getZ(i);
      if (kind === 'snow') {
        y -= dt * 90;
        x += Math.sin(elapsed * 0.0008 + phase) * dt * 20;
      } else if (kind === 'embers') {
        y += dt * (60 + (phase % 1) * 60);
        x += Math.sin(elapsed * 0.002 + phase) * dt * 30;
      } else if (kind === 'fireflies') {
        x += Math.sin(elapsed * 0.0007 + phase) * dt * 40;
        z += Math.cos(elapsed * 0.0006 + phase * 1.3) * dt * 40;
        y += Math.sin(elapsed * 0.001 + phase * 0.7) * dt * 20;
      } else {
        x += dt * 18;
        y += Math.sin(elapsed * 0.0005 + phase) * dt * 6;
      }
      if (y < min.y) y = max.y;
      if (y > max.y) y = min.y;
      if (x > max.x) x = min.x;
      attribute.setXYZ(i, x, y, z);
    }
    attribute.needsUpdate = true;
    if (kind === 'fireflies') material.opacity = 0.7 + Math.sin(elapsed * 0.004) * 0.25;
  };
  return { points, update };
}

/** Terrain disc with gentle, deterministic undulation that stays flat under
 * the diorama's footprint so no floor ever looks buried. */
function terrain(color: number, environment: Environment, centerX: number, centerZ: number, radius: number, footprint: Array<{ x: number; z: number }>, random: () => number): THREE.Mesh {
  // A ring grid (not a circle fan) so the interior has vertices for relief.
  const ring = new THREE.RingGeometry(0.001, radius, 96, 28);
  ring.rotateX(-Math.PI / 2);
  const position = ring.getAttribute('position');
  const colors: number[] = [];
  const base = new THREE.Color(color);
  const tint = new THREE.Color();
  const amplitude = environment === 'desert' ? 90 : environment === 'snow' ? 45 : environment === 'city' ? 0 : 38;
  const seedA = random() * 10;
  const seedB = random() * 10;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) + centerX;
    const z = position.getZ(i) + centerZ;
    let nearest = Infinity;
    for (const cell of footprint) nearest = Math.min(nearest, Math.hypot(x - cell.x, z - cell.z));
    const flatten = THREE.MathUtils.smoothstep(nearest, CELL * 0.9, CELL * 2.4);
    const wave = Math.sin(x * 0.0011 + seedA) * Math.cos(z * 0.0013 + seedB) + Math.sin((x + z) * 0.0006 + seedB) * 0.6;
    position.setY(i, wave * amplitude * flatten);
    const shade = 1 + (Math.sin(x * 0.004 + seedB) * Math.cos(z * 0.0035 + seedA)) * 0.06 - (1 - flatten) * 0.03;
    tint.copy(base).multiplyScalar(shade);
    colors.push(tint.r, tint.g, tint.b);
  }
  ring.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  ring.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: environment === 'snow' ? 0.7 : 1, metalness: 0, flatShading: environment === 'desert' || environment === 'volcanic' || environment === 'cavern' });
  const mesh = new THREE.Mesh(ring, material);
  mesh.position.set(centerX, GROUND_Y, centerZ);
  mesh.receiveShadow = true;
  return mesh;
}

function sea(centerX: number, centerZ: number, radius: number): { mesh: THREE.Mesh; update: (dt: number, elapsed: number) => void } {
  const geometry = new THREE.PlaneGeometry(radius * 2, radius * 2, 60, 60);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({ color: 0x2f7394, roughness: 0.18, metalness: 0.2, emissive: 0x0b2a3c, emissiveIntensity: 0.4, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(centerX, GROUND_Y - 22, centerZ);
  mesh.receiveShadow = true;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const baseX = Float32Array.from({ length: position.count }, (_, i) => position.getX(i));
  const baseZ = Float32Array.from({ length: position.count }, (_, i) => position.getZ(i));
  let accumulator = 0;
  return {
    mesh,
    update: (dt, elapsed) => {
      // Waves update at ~20 Hz: visually smooth, a fraction of the cost.
      accumulator += dt;
      if (accumulator < 0.05) return;
      accumulator = 0;
      const t = elapsed * 0.001;
      for (let i = 0; i < position.count; i++) {
        const x = baseX[i]!;
        const z = baseZ[i]!;
        position.setY(i, Math.sin(x * 0.002 + t) * 9 + Math.cos(z * 0.0024 + t * 1.3) * 7);
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
    },
  };
}

/** Merge static groups into one mesh per (material, shadow) bucket. */
function mergeStatic(groups: THREE.Group[]): THREE.Mesh[] {
  const buckets = new Map<string, { material: THREE.Material; castShadow: boolean; geometries: THREE.BufferGeometry[] }>();
  const leftovers: THREE.Mesh[] = [];
  for (const group of groups) {
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const material = object.material as THREE.MeshStandardMaterial;
      if (material.map !== null && material.map !== undefined) {
        // Textured meshes keep their UVs; they are rare enough to leave alone.
        const baked = new THREE.Mesh(object.geometry.clone().applyMatrix4(object.matrixWorld), material);
        baked.castShadow = object.castShadow;
        baked.receiveShadow = true;
        leftovers.push(baked);
        return;
      }
      let geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      if (geometry.index !== null) geometry = geometry.toNonIndexed();
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
      }
      const key = `${material.uuid}|${object.castShadow ? 1 : 0}`;
      const bucket = buckets.get(key) ?? { material, castShadow: object.castShadow, geometries: [] };
      bucket.geometries.push(geometry);
      buckets.set(key, bucket);
    });
  }
  const meshes: THREE.Mesh[] = [...leftovers];
  for (const bucket of buckets.values()) {
    const merged = mergeGeometries(bucket.geometries, false);
    for (const geometry of bucket.geometries) geometry.dispose();
    if (merged === null) continue;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  for (const group of groups) {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
  return meshes;
}

export function buildScenery(level: Level, options: SceneryOptions): SceneryBuild {
  const { environment, lighting } = options;
  const air = atmosphere(environment, lighting);
  const environmentRoot = new THREE.Group();
  environmentRoot.name = 'environment';
  const mats = new MaterialCache();
  const updates: Array<(dt: number, elapsed: number) => void> = [];
  const disposables: Array<{ dispose(): void }> = [mats];
  const random = seededRandom(hashString(level.modules.map((m) => `${m.id}${m.x}${m.z}${m.h}`).join('|')));
  const dark = lighting === 'night' || environment === 'cavern' || environment === 'space';
  const crystal = environment === 'volcanic' ? 0xff7a45 : environment === 'cavern' ? 0xa98cff : environment === 'snow' ? 0xc4ecff : 0x7fd8ff;
  const ctx: PropContext = { snowy: environment === 'snow', dark, accent: options.accent, stone: options.stone, crystal, mats };

  // Footprint of the playable diorama in world space.
  const footprintCells = new Set(level.modules.map((m) => `${m.x},${m.z}`));
  const footprint = [...footprintCells].map((cell) => {
    const [x, z] = cell.split(',').map(Number) as [number, number];
    return cellCenter(x, z);
  });
  const bounds = new THREE.Box3();
  for (const module of level.modules) {
    const c = centerPoint(module);
    bounds.expandByPoint(new THREE.Vector3(c.x - CELL / 2, GROUND_Y, c.z - CELL / 2));
    bounds.expandByPoint(new THREE.Vector3(c.x + CELL / 2, c.y + 300, c.z + CELL / 2));
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const footprintRadius = bounds.getSize(new THREE.Vector3()).setY(0).length() / 2;

  const detail: { terrain: THREE.Mesh | null; particles: THREE.Points | null; shadowCasters: THREE.Mesh[] } = {
    terrain: null,
    particles: null,
    shadowCasters: [],
  };
  let fog: THREE.Fog | null = null;
  if (environment !== 'void') {
    const dome = skyDome(air.skyTop, air.horizon, 45000);
    dome.position.set(center.x, 0, center.z);
    environmentRoot.add(dome);
    disposables.push(dome.geometry, dome.material as THREE.Material);
    fog = new THREE.Fog(air.horizon, 4000, 12000);
    if (lighting === 'night' || environment === 'space') {
      const stars = starfield(40000, environment === 'space' ? 1400 : 700, random);
      stars.position.set(center.x, 0, center.z);
      environmentRoot.add(stars);
      disposables.push(stars.geometry, stars.material as THREE.Material);
    }
  }

  const groundColor = GROUND_COLOR[environment];
  const groundRadius = footprintRadius + 9000;
  if (groundColor !== null) {
    const ground = terrain(groundColor, environment, center.x, center.z, groundRadius, footprint, random);
    detail.terrain = ground;
    environmentRoot.add(ground);
    disposables.push(ground.geometry, ground.material as THREE.Material);
  }
  if (environment === 'sea') {
    const water = sea(center.x, center.z, groundRadius);
    environmentRoot.add(water.mesh);
    updates.push(water.update);
    disposables.push(water.mesh.geometry, water.mesh.material as THREE.Material);
    // Sandy islands under every occupied cell and every landmark on open water.
    const sand = mats.get(0xd9c49a, { rough: 1 });
    const islandCells = [
      ...footprint,
      ...(level.props ?? [])
        .filter((prop) => !GROUND_TILE_PROPS.has(prop.prop) && !footprintCells.has(`${prop.x},${prop.z}`))
        .map((prop) => cellCenter(prop.x, prop.z)),
    ];
    for (const cell of islandCells) {
      const island = new THREE.Mesh(new THREE.CylinderGeometry(260, 300, 40, 10), sand);
      island.position.set(cell.x, GROUND_Y - 18, cell.z);
      island.receiveShadow = true;
      environmentRoot.add(island);
      disposables.push(island.geometry);
    }
  }
  if (environment === 'space') {
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(5200, 48, 32),
      new THREE.MeshStandardMaterial({ color: 0x4a6aa8, roughness: 0.9, emissive: 0x1a2a58, emissiveIntensity: 0.35 }),
    );
    planet.position.set(center.x - 16000, -3000, center.z - 20000);
    const ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(6400, 8800, 64),
      new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }),
    );
    ringMesh.position.copy(planet.position);
    ringMesh.rotation.set(Math.PI / 2.3, 0.3, 0);
    environmentRoot.add(planet, ringMesh);
    disposables.push(planet.geometry, planet.material as THREE.Material, ringMesh.geometry, ringMesh.material as THREE.Material);
  }

  // ---- Landmark props (author placed) ----
  const landmarks: LandmarkPlacement[] = [];
  const glows: Array<{ color: number; position: THREE.Vector3; strength: number }> = [];
  const occupiedByProps = new Set<string>();
  const slotsUsed = new Map<string, number>();
  const cornerSlots = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
  const moduleCenters = level.modules.map((module) => centerPoint(module));
  for (const prop of level.props ?? []) {
    const cellKey = `${prop.x},${prop.z}`;
    occupiedByProps.add(cellKey);
    const built: BuiltProp = buildProp(prop.prop, ctx, hashString(prop.id));
    const host = landmarkHost(level, prop);
    const cell = cellCenter(prop.x, prop.z);
    const slot = slotsUsed.get(cellKey) ?? 0;
    slotsUsed.set(cellKey, slot + 1);
    const tile = GROUND_TILE_PROPS.has(prop.prop);
    const sharesCell = (level.props ?? []).filter((other) => other.x === prop.x && other.z === prop.z && !GROUND_TILE_PROPS.has(other.prop)).length > 1;
    const corner = cornerSlots[slot % 4]!;
    const offset = tile ? 0 : host.onModule ? 112 : sharesCell ? 95 : 0;
    const x = cell.x + corner[0] * offset;
    const z = cell.z + corner[1] * offset;
    built.group.position.set(x, host.y, z);
    if (host.onModule && !tile) built.group.scale.setScalar(built.tall ? 0.62 : 0.8);
    if (!tile) {
      // Face the nearest walkable module, so guardians look at the path.
      let target: { x: number; z: number } | null = null;
      let best = Infinity;
      for (const c of moduleCenters) {
        const distance = Math.hypot(c.x - x, c.z - z);
        if (distance > 1 && distance < best) {
          best = distance;
          target = c;
        }
      }
      if (host.onModule) target = { x: cell.x, z: cell.z };
      if (target !== null) built.group.rotation.y = Math.atan2(target.x - x, target.z - z);
    }
    built.group.userData.propId = prop.id;
    landmarks.push({ id: prop.id, object: built.group, base: new THREE.Vector3(x, host.y, z), tile });
    if (built.update) updates.push(built.update);
    if (built.glow) {
      glows.push({
        color: built.glow.color,
        position: built.glow.offset.clone().multiplyScalar(built.group.scale.x).applyAxisAngle(new THREE.Vector3(0, 1, 0), built.group.rotation.y).add(built.group.position),
        strength: built.glow.strength,
      });
    }
  }

  // ---- Environmental scatter (deterministic) ----
  const table = SCATTER[environment];
  if (table.tall.length > 0 || table.low.length > 0) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const module of level.modules) {
      minX = Math.min(minX, module.x); maxX = Math.max(maxX, module.x);
      minZ = Math.min(minZ, module.z); maxZ = Math.max(maxZ, module.z);
    }
    const margin = environment === 'city' ? 7 : 6;
    const cells: Array<{ x: number; z: number; d: number }> = [];
    const occupied = [...footprintCells].map((cell) => cell.split(',').map(Number) as [number, number]);
    for (let x = minX - margin; x <= maxX + margin; x++) {
      for (let z = minZ - margin; z <= maxZ + margin; z++) {
        const key = `${x},${z}`;
        if (footprintCells.has(key) || occupiedByProps.has(key)) continue;
        let d = Infinity;
        for (const [ox, oz] of occupied) d = Math.min(d, Math.max(Math.abs(ox - x), Math.abs(oz - z)));
        cells.push({ x, z, d });
      }
    }
    const camLength = Math.hypot(options.cameraSide.x, options.cameraSide.z) || 1;
    const cam = { x: options.cameraSide.x / camLength, z: options.cameraSide.z / camLength };
    let placed = 0;
    const cap = environment === 'city' ? 46 : 64;
    const staticScatter: THREE.Group[] = [];
    for (const cell of cells) {
      if (placed >= cap) break;
      const world = cellCenter(cell.x, cell.z);
      const toward = ((world.x - center.x) * cam.x + (world.z - center.z) * cam.z) / CELL;
      const cameraSide = toward > 0;
      const probability = environment === 'city'
        ? (cell.d >= 2 && !(cameraSide && cell.d <= 4) ? 0.42 : 0)
        : environment === 'sea' ? (cell.d >= 2 ? 0.07 : 0)
          : cell.d === 1 ? 0.2 : cell.d === 2 ? 0.32 : 0.4;
      if (random() > probability) continue;
      // Tall scatter never stands between the author's camera and the puzzle.
      const allowTall = !(cameraSide && cell.d <= 4) && cell.d >= 2;
      const kind = allowTall && random() < 0.62 ? pick(table.tall, random) ?? pick(table.low, random) : pick(table.low, random);
      if (kind === null) continue;
      const built = buildProp(kind, ctx, hashString(`${cell.x}:${cell.z}:${kind}`));
      const jitterX = (random() - 0.5) * CELL * 0.5;
      const jitterZ = (random() - 0.5) * CELL * 0.5;
      built.group.position.set(world.x + jitterX, GROUND_Y, world.z + jitterZ);
      built.group.rotation.y = random() * Math.PI * 2;
      if (kind !== 'building') built.group.scale.setScalar(0.8 + random() * 0.5);
      built.group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = built.tall && cell.d <= 3;
          object.receiveShadow = true;
        }
      });
      if (built.update) {
        environmentRoot.add(built.group);
        updates.push(built.update);
      } else {
        staticScatter.push(built.group);
      }
      if (built.glow && (lighting !== 'day' || environment === 'volcanic' || environment === 'cavern')) {
        glows.push({ color: built.glow.color, position: built.glow.offset.clone().add(built.group.position), strength: built.glow.strength * 0.6 });
      }
      placed += 1;
    }
    // Static scatter is baked into one mesh per material: dozens of trees
    // become a handful of draw calls, which keeps low-end GPUs smooth.
    for (const merged of mergeStatic(staticScatter)) {
      environmentRoot.add(merged);
      disposables.push(merged.geometry);
      if (merged.castShadow) detail.shadowCasters.push(merged);
    }
  }
  if (environment === 'space') {
    for (let i = 0; i < 14; i++) {
      const built = buildProp('asteroid', ctx, hashString(`asteroid-${i}`) + Math.floor(random() * 1000));
      const angle = random() * Math.PI * 2;
      const distance = footprintRadius + 900 + random() * 3200;
      built.group.position.set(center.x + Math.cos(angle) * distance, -600 + random() * 1400, center.z + Math.sin(angle) * distance);
      built.group.scale.setScalar(0.6 + random() * 1.6);
      environmentRoot.add(built.group);
      if (built.update) updates.push(built.update);
    }
  }

  // ---- Particles ----
  const particleType = particleKind(environment, lighting);
  if (particleType !== null) {
    const system = particles(particleType, bounds, random);
    environmentRoot.add(system.points);
    detail.particles = system.points;
    updates.push(system.update);
    disposables.push(system.points.geometry, system.points.material as THREE.Material);
  }

  // ---- Local lights from glowing props (dusk and night) ----
  const lights: THREE.PointLight[] = [];
  if (lighting !== 'day' || environment === 'cavern' || environment === 'volcanic') {
    const ranked = glows
      .map((glow) => ({ ...glow, distance: Math.hypot(glow.position.x - center.x, glow.position.z - center.z) }))
      .sort((a, b) => b.strength - a.strength || a.distance - b.distance)
      .slice(0, 6);
    for (const glow of ranked) {
      const light = new THREE.PointLight(glow.color, (lighting === 'day' ? 250 : lighting === 'dusk' ? 450 : 900) * glow.strength, 1800, 1);
      light.position.copy(glow.position);
      lights.push(light);
    }
  }

  const reduced = options.reduced;
  return {
    environmentRoot,
    landmarks,
    lights,
    fog,
    update: (dt, elapsed) => {
      if (reduced()) return;
      for (const update of updates) update(dt, elapsed);
    },
    reduceDetail: () => {
      // Shadow sampling across the whole terrain is the largest per-pixel
      // cost; the diorama keeps its own shadows.
      if (detail.particles !== null) detail.particles.visible = false;
      if (detail.terrain !== null) {
        detail.terrain.receiveShadow = false;
        (detail.terrain.material as THREE.Material).needsUpdate = true;
      }
      for (const caster of detail.shadowCasters) caster.castShadow = false;
    },
    setFogRange: (fitDistance) => {
      if (fog === null) return;
      // Haze belongs to the horizon, never to the puzzle: small scenes still
      // get a deep, clear foreground.
      fog.near = Math.max(fitDistance * 1.1, 3800);
      fog.far = Math.max(fitDistance * air.fogReach, environment === 'swamp' ? 10000 : 15000);
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
      environmentRoot.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const material = object.material as THREE.Material | THREE.Material[];
          for (const m of Array.isArray(material) ? material : [material]) m.dispose();
        }
      });
      for (const light of lights) light.dispose();
    },
  };
}
