import * as THREE from 'three';
import { playSound } from './sound.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MoveRecord } from '../core/movement.js';
import { CARDINALS, type Cardinal, type Door, type LevelModule } from '../../shared/schema.js';
import { GEOMETRY, centerPoint, dirDelta, portPoint, type Vec3 } from '../core/catalog.js';
import { doorPassable, initialState } from '../core/movement.js';
import { craftedBox, rampGeometry, sceneBounds, framingPoints, fitOverview } from './craft.js';
import { createMechanisms, type WorldVisuals } from './mechanisms.js';
import { buildKeyLook } from './props.js';
import { preloadCharacter } from './character.js';
import { atmosphere, buildScenery, FOUNDATION_TOP_Y, GROUND_Y } from './scenery.js';
import type { PreviewMarker } from './preview-diff.js';
import { revisionId } from '../core/serialize.js';
import { artDirection, switchSignature, type ArtDirection, type ThemeKey } from './art-direction.js';
import type { Level } from '../../shared/schema.js';
import { neighbor, type CompiledLevel } from '../core/topology.js';
import { previewDiff } from './preview-diff.js';
import type { PreviewState } from '../core/preview.js';
import {
  GhostActor,
  PlayerActor,
  reducedMotion,
  type ActorContext,
  type GhostCallbacks,
  type PlayerCallbacks,
} from './actors.js';

/**
 * Imperative Three.js diorama built from the compiled level (§3, §12).
 * Rendering never decides movement legality — it consumes the same catalog
 * the core uses. The camera holds the full puzzle during play; users own
 * orbit and zoom, with an explicit return to the framed overview.
 */

const COLORS = {
  background: 0x101216,
  floor: 0xb4aa94,
  bridge: 0x849ca4,
  ramp: 0xb4aa94,
  wall: 0x827b6d,
  rail: 0x53646b,
  stage: 0x292e35,
  sky: 0xd8e4ee,
  groundLight: 0x82715e,
  keyLight: 0xffecd1,
  fillLight: 0xbad3ed,
  silver: 0xc4d3df,
  copper: 0xdc9870,
  // Brass family: the key and the door it opens share the accent (§12).
  doorKey: 0xc9a227,
  key: 0xd4af37,
  // Danger family: the sealing door and its switch are one mechanism.
  doorSeal: 0x74302f,
  switchPad: 0xb0533a,
  // Ghost/player families mirror the shell's fail and text tokens.
  ghost: 0xd57064,
  player: 0xd7d2c4,
  doorPlain: 0x6f6a60,
  spawn: 0xd7d2c4,
  // The goal mirrors the shell's --color-pass: reaching it is the pass state.
  goal: 0x3fa66a,
} as const;

const WALL_HEIGHT_CM = 88;
const RAIL_HEIGHT_CM = 60;
const WALL_THICKNESS_CM = 24;
const DOOR_POST_HEIGHT_CM = 200;

interface Mats {
  trim: THREE.MeshStandardMaterial;
  floor: THREE.MeshStandardMaterial;
  bridge: THREE.MeshStandardMaterial;
  ramp: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  doorKey: THREE.MeshStandardMaterial;
  doorSeal: THREE.MeshStandardMaterial;
  doorPlain: THREE.MeshStandardMaterial;
  key: THREE.MeshStandardMaterial;
  switchPad: THREE.MeshStandardMaterial;
  switchRim: THREE.MeshStandardMaterial;
  spawn: THREE.MeshStandardMaterial;
  goal: THREE.MeshStandardMaterial;
  goalHalo: THREE.MeshStandardMaterial;
}

/** Mutable per-entity visuals driven by engine state (§12): doors that
 * seal, plates that depress, keys that vanish into inventory. */
function standard(color: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.85 });
}

function lit(color: number, emissive: number, intensity: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: intensity,
    metalness,
    roughness: 0.7,
  });
}

function buildMats(direction: ArtDirection): Mats {
  return {
    trim: standard(direction.trim, 0.2),
    floor: standard(direction.floor),
    bridge: standard(direction.metal, 0.25),
    ramp: standard(direction.floor),
    wall: standard(direction.wall),
    rail: standard(direction.metal, 0.4),
    doorKey: lit(COLORS.doorKey, 0x6b5312, 0.45, 0.55),
    doorSeal: lit(COLORS.doorSeal, 0x3a100e, 0.55),
    doorPlain: standard(COLORS.doorPlain),
    key: lit(COLORS.key, 0x8a6d1c, 0.75, 0.65),
    switchPad: lit(COLORS.switchPad, 0x7a2a1c, 0.9),
    switchRim: lit(COLORS.doorSeal, 0x3a100e, 0.65),
    spawn: lit(COLORS.spawn, 0x55504a, 0.25),
    goal: lit(COLORS.goal, 0x2c8a52, 1.3, 0.2),
    goalHalo: lit(COLORS.goal, 0x2c8a52, 1.0),
  };
}

export interface SceneHandle {
  dispose(): void;
  frameLevel(): void;
  spawnGhost(
    route: MoveRecord[],
    kind: 'solution' | 'bypass' | 'dead_end' | 'replay',
    missingKeys: string[],
    callbacks: GhostCallbacks,
    pauseAfterMoveIndex?: number | null,
  ): GhostActor;
  /** Before/after markers for one validated AI or repair candidate (§9). */
  previewOperations(preview: PreviewState | null): void;
  /** Click-to-select: the scene reports picked entity ids (null = empty
   * space). "Select something, then describe the change" (§12). */
  onPick(handler: ((id: string | null) => void) | null): void;
  /** Brass rings on the currently selected entities. */
  setSelection(ids: string[]): void;
  /** Cream outer rings on entities the creator marked "keep this" (§9). */
  setProtected(ids: string[]): void;
  /** Amber outer rings for engine-owned failure evidence. */
  setEvidence(ids: string[]): void;
  spawnPlayer(callbacks: PlayerCallbacks): PlayerActor;
  /** Arrow-key orbiting is disabled while manual play owns the arrows. */
  setKeyboardOrbit(enabled: boolean): void;
  /** Manual play: chase the player (true) or hold the overview (false). */
  setFollow(enabled: boolean): void;
  /** The world direction the camera faces, for camera-relative controls. */
  onFacing(handler: ((facing: Cardinal) => void) | null): void;
  /** Overlay the engine's per-module recovery analysis on the floors. */
  setAnalysis(map: { stranded: string[]; unreachable: string[] } | null): void;
  /** Analysis overlays are the author's view — never shown while playing. */
  setAnalysisVisible(visible: boolean): void;
}

function layoutCenter(compiled: CompiledLevel): Vec3 {
  const modules = compiled.level.modules;
  const sum = modules.reduce(
    (acc, m) => {
      const c = centerPoint(m);
      return { x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z };
    },
    { x: 0, y: 0, z: 0 },
  );
  const count = Math.max(modules.length, 1);
  return { x: sum.x / count, y: sum.y / count, z: sum.z / count };
}

/**
 * A wall or rail block along one edge of a module. N/S edges run along x;
 * E/W edges run along z.
 */
function addEdgeBlock(
  world: THREE.Group,
  m: LevelModule,
  dir: Cardinal,
  height: number,
  material: THREE.MeshStandardMaterial,
  trim: THREE.MeshStandardMaterial,
): void {
  const c = centerPoint(m);
  const half = GEOMETRY.cellPitchCm / 2;
  const { dx, dz } = dirDelta(dir);
  const alongX = dz !== 0;
  const edge = new THREE.Group();
  edge.position.set(c.x + dx * half, c.y, c.z + dz * half);
  if (!alongX) edge.rotation.y = Math.PI / 2;
  const part = (width: number, h: number, depth: number, x: number, y: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(craftedBox(width, h, depth), mat);
    mesh.position.set(x, y, 0);
    edge.add(mesh);
  };
  if (m.template === 'bridge') {
    // Open railings reveal the lower route instead of hiding it behind a slab.
    part(400, 12, 16, 0, height, trim);
    part(400, 10, 14, 0, 12, material);
    for (const x of [-184, 0, 184]) part(12, height, 12, x, height / 2, material);
  } else {
    part(400, height, WALL_THICKNESS_CM, 0, height / 2, material);
    part(400, 10, WALL_THICKNESS_CM + 6, 0, height + 3, trim);
    for (const x of [-184, 184]) part(24, height + 14, 30, x, (height + 14) / 2, material);
  }
  world.add(edge);
}

function addModule(world: THREE.Group, mats: Mats, compiled: CompiledLevel, m: LevelModule): void {
  const c = centerPoint(m);
  if (m.template === 'ramp') {
    const mesh = new THREE.Mesh(
      rampGeometry(m),
      mats.ramp,
    );
    mesh.position.set(c.x, c.y, c.z);
    world.add(mesh);
    // Finished stringers sit inside the ramp footprint, outside the walking lane.
    const alongZ = m.orientation === 'N' || m.orientation === 'S';
    const angle = Math.atan2(GEOMETRY.floorSpacingCm, GEOMETRY.cellPitchCm);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(craftedBox(14, 18, 500), mats.rail);
      rail.rotation.x = angle;
      const group = new THREE.Group();
      group.rotation.y = m.orientation === 'N' ? 0 : m.orientation === 'E' ? -Math.PI / 2 : m.orientation === 'S' ? Math.PI : Math.PI / 2;
      group.add(rail);
      group.position.set(c.x + (alongZ ? side * 185 : 0), c.y + 8, c.z + (alongZ ? 0 : side * 185));
      world.add(group);
    }
    return;
  }

  const mesh = new THREE.Mesh(
    craftedBox(
      GEOMETRY.cellPitchCm - 2,
      GEOMETRY.floorSlabThicknessCm,
      GEOMETRY.cellPitchCm - 2,
    ),
    m.template === 'bridge' ? mats.bridge : mats.floor,
  );
  mesh.position.set(c.x, c.y - GEOMETRY.floorSlabThicknessCm / 2, c.z);
  world.add(mesh);

  // Closed sides get walls; open sides with no connection get visible edge
  // protection — unmatched openings are legal but impassable (§4.1).
  for (const dir of CARDINALS) {
    if (!m.ports.includes(dir)) {
      addEdgeBlock(world, m, dir, m.template === 'bridge' ? RAIL_HEIGHT_CM : WALL_HEIGHT_CM, m.template === 'bridge' ? mats.rail : mats.wall, mats.trim);
    } else if (neighbor(compiled, m.id, dir) === null) {
      addEdgeBlock(world, m, dir, RAIL_HEIGHT_CM, mats.rail, mats.trim);
    }
  }
  if (m.template === 'bridge') {
    // Riveted cross-members make bridges read as a distinct construction.
    for (const offset of [-150, 150]) {
      const beam = new THREE.Mesh(craftedBox(388, 22, 18), mats.rail);
      beam.position.set(c.x, c.y - 38, c.z + offset);
      world.add(beam);
    }
  } else if (m.ports.length >= 3 || m.id === compiled.goal) {
    // Junctions and destination rooms have inset paving, rather than every
    // tile carrying the same decoration. The walking surface stays at y=0.
    const inlay = new THREE.Mesh(new THREE.RingGeometry(100, 104, m.id === compiled.goal ? 32 : 4), mats.trim);
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.set(c.x, c.y + 1.5, c.z);
    world.add(inlay);
  }
  if (m.h > 0 && m.template === 'flat' && m.ports.length <= 2 &&
      !compiled.level.modules.some(other => other.id !== m.id && other.x === m.x && other.z === m.z && other.h < m.h)) {
    // Piers exist only in empty space, never through a playable lower tile.
    const height = c.y + 30;
    for (const side of [-1, 1]) {
      const pier = new THREE.Mesh(craftedBox(64, height, 64), mats.wall);
      pier.position.set(c.x + side * 160, (c.y - 30 - 60) / 2, c.z + 160);
      world.add(pier);
      // Feet reach down to the terrain so raised floors never hover over it.
      const foot = new THREE.Mesh(craftedBox(84, 30, 84), mats.trim);
      foot.position.set(pier.position.x, GROUND_Y + 15, pier.position.z);
      world.add(foot);
    }
  }
}

function keyStyle(compiled: CompiledLevel, id: string): { color: number; sides: number } {
  const index = [...compiled.keyBit.keys()].sort().indexOf(id);
  const colors = [COLORS.key, COLORS.silver, COLORS.copper];
  return { color: id.includes('silver') ? COLORS.silver : id.includes('gold') || id.includes('brass') ? COLORS.key : colors[Math.max(0, index) % colors.length]!, sides: 4 + Math.max(0, index) * 2 };
}

function doorMaterial(mats: Mats, door: Door): THREE.MeshStandardMaterial {
  const conditions = door.conditions;
  if (conditions?.requiresKey !== undefined || conditions?.requiresKeys !== undefined) return mats.doorKey;
  if (conditions?.closesAfterSwitch !== undefined) return mats.doorSeal;
  if (conditions?.requiresSwitch !== undefined) return mats.switchPad;
  return mats.doorPlain;
}

/** Tracked shutter: side guides and a header cassette contain the moving leaf. */
function addDoorFrames(
  world: THREE.Group,
  mats: Mats,
  compiled: CompiledLevel,
  visuals: WorldVisuals,
  tag?: (root: THREE.Object3D, id: string) => void,
): void {
  for (const door of compiled.level.doors) {
    const material = doorMaterial(mats, door).clone();
    const identity = door.conditions?.requiresKey ?? door.conditions?.requiresKeys?.[0];
    if (identity !== undefined) {
      material.color.setHex(keyStyle(compiled, identity).color);
      material.emissive.copy(material.color);
      material.emissiveIntensity = 0.12;
      material.roughness = 0.4;
    } else if (door.conditions?.requiresSwitch !== undefined) {
      material.color.setHex(switchSignature(compiled, door.conditions.requiresSwitch).color);
      material.emissive.copy(material.color);
      material.emissiveIntensity = 0.12;
    }
    const doorStart = world.children.length;
    for (const dir of CARDINALS) {
      if (neighbor(compiled, door.a, dir)?.toId !== door.b) continue;
      const a = compiled.moduleById.get(door.a);
      if (!a) continue;
      const p = portPoint(a, dir);
      const alongX = dir === 'N' || dir === 'S';
      // The gate spans the corridor; the catalog's narrower port remains
      // the authoritative center crossing, not a visible gap around a door.
      const aperture = GEOMETRY.cellPitchCm - 2 * WALL_THICKNESS_CM;
      const offset = aperture / 2 + WALL_THICKNESS_CM / 2;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(
          craftedBox(WALL_THICKNESS_CM, DOOR_POST_HEIGHT_CM, WALL_THICKNESS_CM),
          material,
        );
        post.position.set(
          p.x + (alongX ? side * offset : 0),
          p.y + DOOR_POST_HEIGHT_CM / 2,
          p.z + (alongX ? 0 : side * offset),
        );
        world.add(post);
      }
      const span = aperture + 2 * WALL_THICKNESS_CM;
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(
          alongX ? span : WALL_THICKNESS_CM,
          WALL_THICKNESS_CM,
          alongX ? WALL_THICKNESS_CM : span,
        ),
        material,
      );
      lintel.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM, p.z);
      world.add(lintel);
      if (door.conditions !== undefined) {
        const housing = new THREE.Mesh(craftedBox(alongX ? span + 18 : 54, 38, alongX ? 54 : span + 18), mats.rail);
        housing.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM + 13, p.z);
        world.add(housing);
        const switches = [door.conditions.requiresSwitch, door.conditions.closesAfterSwitch].filter((id): id is string => id !== undefined);
        switches.forEach((id, index) => {
          const signature = switchSignature(compiled, id);
          const marker = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 5, signature.sides), standard(signature.color));
          const offset = -span / 2 + 28 + index * 42;
          marker.position.set(p.x + (alongX ? offset : 0), p.y + DOOR_POST_HEIGHT_CM + 35, p.z + (alongX ? 0 : offset));
          world.add(marker);
        });
        for (const side of [-1, 1]) {
          const guide = new THREE.Mesh(craftedBox(8, DOOR_POST_HEIGHT_CM, 8), mats.trim);
          guide.position.set(p.x + (alongX ? side * (aperture / 2 + 3) : 0), p.y + DOOR_POST_HEIGHT_CM / 2, p.z + (alongX ? 0 : side * (aperture / 2 + 3)));
          world.add(guide);
        }
      }
      const sill = new THREE.Mesh(
        craftedBox(alongX ? aperture : 12, 10, alongX ? 12 : aperture),
        material,
      );
      sill.position.set(p.x, p.y + 5, p.z);
      world.add(sill);
      // Portcullis slab for stateful doors: keyed doors rest LOCKED (the
      // vault reads as locked); sealing doors rest OPEN and slam when their
      // switch fires. The engine decides openness — doorPassable() below.
      const conditions = door.conditions;
      if (conditions !== undefined) {
        const slab = new THREE.Group();
        const slabHeight = DOOR_POST_HEIGHT_CM - 14;
        const barCount = 7;
        for (let bar = 0; bar < barCount; bar++) {
          const barMesh = new THREE.Mesh(
            craftedBox(alongX ? aperture : 14, 22, alongX ? 14 : aperture),
            material,
          );
          barMesh.position.y = 14 + bar * 26;
          slab.add(barMesh);
        }
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(
            alongX ? aperture + 8 : 12,
            12,
            alongX ? 12 : aperture + 8,
          ),
          material,
        );
        rail.position.y = slabHeight;
        slab.add(rail);
        const startsOpen = doorPassable(compiled, door.id, initialState(compiled));
        slab.userData.retracts = true;
        slab.position.set(p.x, p.y, p.z);
        world.add(slab);
        visuals.doors.set(door.id, {
          group: slab,
          openY: p.y + slabHeight,
          closedY: p.y,
          targetOpen: startsOpen,
        });
      }
      // Type telegraph: a keyhole gem on keyed doors, a warning bar on seals.
      const requiredKeys = conditions?.requiresKeys ?? (conditions?.requiresKey !== undefined ? [conditions.requiresKey] : []);
      if (requiredKeys.length > 0) {
        // One keyhole gem per required key, fanned across the lintel.
        const span = Math.min(requiredKeys.length, 3);
        for (let i = 0; i < span; i++) {
          const gem = new THREE.Mesh(
            new THREE.TorusGeometry(12, 4, 6, keyStyle(compiled, requiredKeys[i]!).sides),
            new THREE.MeshStandardMaterial({ color: keyStyle(compiled, requiredKeys[i]!).color, roughness: 0.35, metalness: 0.4 }),
          );
          const offset = (i - (span - 1) / 2) * 34;
          gem.position.set(
            p.x + (alongX ? offset : 0),
            p.y + DOOR_POST_HEIGHT_CM + 48,
            p.z + (alongX ? 0 : offset),
          );
          if (!alongX) gem.rotation.y = Math.PI / 2;
          world.add(gem);
        }
      }
      if (conditions?.closesAfterSwitch !== undefined) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(alongX ? span * 0.72 : 14, 10, alongX ? 14 : span * 0.72),
          new THREE.MeshBasicMaterial({ color: 0x9e3d35, transparent: true, opacity: 0.85 }),
        );
        bar.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM + 35, p.z);
        world.add(bar);
      }
      break; // exactly one direction joins the two endpoints
    }
    for (const child of world.children.slice(doorStart)) tag?.(child, door.id);
  }
}

type DecorUpdate = (dt: number, elapsed: number) => void;

/**
 * Items get authored silhouettes (§12): a floating key that reads as a key, a
 * pressure-plate switch with a danger rim, and a pass-green goal beacon.
 * Idle spin/bob is disabled under reduced motion.
 */
function addItems(
  world: THREE.Group,
  mats: Mats,
  compiled: CompiledLevel,
  decorUpdates: DecorUpdate[],
  visuals: WorldVisuals,
  tag?: (root: THREE.Object3D, id: string) => void,
  dark = false,
): void {
  for (const key of compiled.level.keys) {
    const m = compiled.moduleById.get(key.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const group = new THREE.Group();
    const style = keyStyle(compiled, key.id);
    const keyMat = mats.key.clone();
    keyMat.color.setHex(style.color);
    keyMat.emissive.setHex(style.color);
    keyMat.emissiveIntensity = 0.15;
    keyMat.roughness = 0.35;
    const look = buildKeyLook(key.look ?? 'key', style.color, keyMat, dark);
    if (look.parts.length > 0) {
      // Cosmetic look (a torch, a gem): same float, spin, and collection.
      group.add(...look.parts);
      if (look.update !== undefined) decorUpdates.push((dt, elapsed) => { if (!reducedMotion()) look.update!(dt, elapsed); });
    } else {
      const bow = new THREE.Mesh(new THREE.TorusGeometry(26, 9, 10, style.sides), keyMat);
      bow.position.x = -36;
      const shaft = new THREE.Mesh(craftedBox(72, 12, 12), keyMat);
      shaft.position.x = 8;
      for (const [x, h] of [
        [28, 24],
        [8, 18],
      ] as const) {
        const tooth = new THREE.Mesh(craftedBox(12, h, 12), keyMat);
        tooth.position.set(x, -6 - h / 2, 0);
        group.add(tooth);
      }
      group.add(bow, shaft);
    }
    group.scale.setScalar(1.6);
    const baseY = c.y + 105;
    group.position.set(c.x, baseY, c.z);
    world.add(group);
    group.userData.baseY = baseY;
    visuals.keys.set(key.id, group);
    tag?.(group, key.id);
    decorUpdates.push((dt, elapsed) => {
      if (reducedMotion()) return;
      if (group.visible && !group.userData.collected) {
        group.rotation.y += dt * 0.7;
        group.position.y = baseY + Math.sin(elapsed * 0.002) * 8;
      }
    });
  }
  for (const pad of compiled.level.switches) {
    const m = compiled.moduleById.get(pad.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(78, 88, 12, 28), mats.wall);
    base.position.set(c.x, c.y + 6, c.z);
    const signature = switchSignature(compiled, pad.id);
    const plateMaterial = mats.switchPad.clone();
    plateMaterial.color.setHex(signature.color);
    plateMaterial.emissive.setHex(signature.color);
    plateMaterial.emissiveIntensity = 0.15;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(46, 50, 16, signature.sides), plateMaterial);
    plate.position.set(c.x, c.y + 14, c.z);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(64, 6, 8, 32), mats.switchRim.clone());
    rim.material.color.setHex(signature.color);
    rim.material.emissive.setHex(signature.color);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(c.x, c.y + 12, c.z);
    plate.userData.restY = plate.position.y;
    world.add(base, plate, rim);
    visuals.switches.set(pad.id, { plate, rim });
    tag?.(base, pad.id);
    tag?.(plate, pad.id);
    tag?.(rim, pad.id);
  }
  const spawn = compiled.moduleById.get(compiled.spawn);
  if (spawn) {
    const c = centerPoint(spawn);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 8, 32), mats.spawn);
    mesh.position.set(c.x, c.y + 4, c.z);
    world.add(mesh);
    tag?.(mesh, compiled.spawn);
  }
  const goal = compiled.moduleById.get(compiled.goal);
  if (goal) {
    const c = centerPoint(goal);
    // A low dais the character can stand on, ringed in the goal color.
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(66, 74, 8, 32), mats.wall);
    pedestal.position.set(c.x, c.y + 4, c.z);
    const inlay = new THREE.Mesh(new THREE.TorusGeometry(58, 3.5, 6, 40), mats.goalHalo);
    inlay.rotation.x = Math.PI / 2;
    inlay.position.set(c.x, c.y + 8.5, c.z);
    world.add(pedestal, inlay);
    const beacon = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(40), mats.goal);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(72, 5, 8, 40), mats.goalHalo);
    halo.rotation.x = Math.PI / 2;
    beacon.add(gem, halo);
    const baseY = c.y + 130;
    beacon.position.set(c.x, baseY, c.z);
    beacon.userData.lift = 0;
    visuals.goal = beacon;
    // Three.js >= r155 uses physical light units; at cm scale, decay-1 with
    // intensity ~= desired illuminance at 1 unit keeps pools readable.
    beacon.add(new THREE.PointLight(COLORS.goal, 320, 1700, 1));
    world.add(beacon);
    tag?.(pedestal, compiled.goal);
    tag?.(beacon, compiled.goal);
    decorUpdates.push((dt, elapsed) => {
      // The lift always applies; only the spin and bob respect reduced motion.
      const still = reducedMotion();
      if (!still) beacon.rotation.y += dt * 0.6;
      beacon.position.y = baseY + (beacon.userData.lift as number) + (still ? 0 : Math.sin(elapsed * 0.0016) * 10);
    });
  }
}

export function mountScene(host: HTMLElement, compiled: CompiledLevel, theme?: ThemeKey): SceneHandle {
  // Start the character download early so play and replays have it ready.
  void preloadCharacter().catch(() => undefined);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);
  const reportRenderState = (state: 'ready' | 'lost'): void => {
    host.dispatchEvent(new CustomEvent('levelproof:render-state', { detail: state }));
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    reportRenderState('lost');
  };
  const onContextRestored = (): void => reportRenderState('ready');
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const direction = artDirection(compiled, theme);
  const mats = buildMats(direction);
  const world = new THREE.Group();
  scene.add(world);
  const environment = compiled.level.scenery?.environment ?? 'void';
  const lighting = compiled.level.scenery?.lighting ?? 'day';
  const air = atmosphere(environment, lighting);
  const dark = lighting === 'night' || environment === 'cavern' || environment === 'space';
  // mesh -> entity id, for click-to-select (§12 "select, then describe").
  const meshToEntity = new Map<THREE.Object3D, string>();
  const visuals: WorldVisuals = { keys: new Map(), switches: new Map(), doors: new Map() };
  const tag = (root: THREE.Object3D, id: string): void => {
    root.traverse((child) => meshToEntity.set(child, id));
  };
  for (const m of compiled.level.modules) {
    const firstIndex = world.children.length;
    addModule(world, mats, compiled, m);
    for (const child of world.children.slice(firstIndex)) tag(child, m.id);
  }
  addDoorFrames(world, mats, compiled, visuals, tag);
  const decorUpdates: DecorUpdate[] = [];
  addItems(world, mats, compiled, decorUpdates, visuals, tag, dark);
  // Scenery: cosmetic world dressing the engine never reads. Landmarks join
  // the pickable world ("move this statue"); terrain and scatter do not.
  const cameraVector = new THREE.Vector3(...direction.camera);
  const scenery = buildScenery(compiled.level, {
    environment,
    lighting,
    accent: direction.trim,
    stone: direction.wall,
    cameraSide: { x: cameraVector.x, z: cameraVector.z },
    reduced: reducedMotion,
  });
  for (const landmark of scenery.landmarks) {
    world.add(landmark.object);
    tag(landmark.object, landmark.id);
  }
  // Everything solid casts and receives; upper floors shadow lower ones.
  world.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  for (const landmark of scenery.landmarks) {
    if (landmark.tile) landmark.object.traverse((obj) => { if (obj instanceof THREE.Mesh) obj.castShadow = false; });
  }
  scene.add(scenery.environmentRoot);
  for (const light of scenery.lights) scene.add(light);
  decorUpdates.push(scenery.update);
  if (environment !== 'void') {
    scene.background = new THREE.Color(air.horizon);
    scene.fog = scenery.fog;
  }
  renderer.toneMappingExposure = air.exposure;

  // Lighting: warm key light with real shadows, cool sky fill, faint ambient.
  // The scene's lighting (day, dusk, night) sets color, strength, and angle.
  const sunColor = lighting === 'day' ? direction.light : air.sunColor;
  const hemiSky = lighting === 'day' && environment === 'void' ? direction.sky : air.hemiSky;
  scene.add(new THREE.HemisphereLight(hemiSky, air.hemiGround, air.hemiIntensity));
  const center = layoutCenter(compiled);
  const sun = new THREE.DirectionalLight(sunColor, air.sunIntensity);
  const sunReach = 6400 * (1 - air.sunElevation) + 1600;
  sun.position.set(center.x - sunReach * 0.87, 6400 * air.sunElevation + 900, center.z + sunReach * 0.48);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 500;
  sun.shadow.camera.far = 20000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 12;
  sun.shadow.radius = 8;
  sun.shadow.blurSamples = 12;
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(lighting === 'day' ? COLORS.fillLight : air.fillColor, air.fillIntensity);
  fill.position.set(center.x + 2500, 1400, center.z - 1800);
  fill.target.position.set(center.x, center.y, center.z);
  scene.add(fill, fill.target);

  const bounds = sceneBounds(compiled.level.modules);
  const shadowExtent = bounds.getSize(new THREE.Vector3()).length() / 2 + 600;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.target.position.copy(bounds.getCenter(new THREE.Vector3()));
  sun.target.updateMatrixWorld();
  // Follow the footprint rather than filling the negative space with a disc.
  const stage = new THREE.Group();
  // On the empty stage the foundations outline the whole footprint. In a
  // dressed world they only seat ground-level floors (raised floors stand on
  // piers), in stone, and never share a height with terrain, islands, or
  // water tiles.
  const dressed = environment !== 'void' && environment !== 'space';
  const foundationMaterial = new THREE.MeshStandardMaterial({
    color: dressed ? new THREE.Color(direction.wall).multiplyScalar(0.8).getHex() : direction.base,
    roughness: 0.9,
  });
  const tileCells = new Set((compiled.level.props ?? []).filter((prop) => prop.prop === 'water' || prop.prop === 'lava').map((prop) => `${prop.x}:${prop.z}`));
  const cells = new Set<string>();
  for (const module of compiled.level.modules) {
    const cell = `${module.x}:${module.z}`;
    if (cells.has(cell) || tileCells.has(cell) || (dressed && module.h !== 0)) continue;
    cells.add(cell);
    const c = centerPoint(module);
    const block = new THREE.Mesh(craftedBox(398, 64, 398, 12), foundationMaterial);
    block.position.set(c.x, FOUNDATION_TOP_Y - 32, c.z);
    block.receiveShadow = true;
    stage.add(block);
  }
  scene.add(stage);

  const viewDir = new THREE.Vector3(...direction.camera).normalize();
  // The orbit never comes closer than 8 m to its target, so a 40 cm near
  // plane costs nothing and quadruples depth precision over a 10 cm one.
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 40, 60000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 700;
  controls.maxDistance = 30000;
  controls.maxPolarAngle = Math.PI / 2.05;
  const homeTarget = bounds.getCenter(new THREE.Vector3());
  const corners = framingPoints(compiled.level.modules);
  const computeFit = (): number => {
    return fitOverview(camera, homeTarget, viewDir, corners);
  };
  let cachedFit = 3000;
  const fitDistance = (): number => cachedFit;
  const frameHome = (): void => {
    controls.target.copy(homeTarget);
    camera.position.copy(homeTarget).addScaledVector(viewDir, fitDistance());
    controls.update();
  };
  frameHome();
  cachedFit = computeFit();
  frameHome();
  scenery.setFogRange(cachedFit);
  // Keyboard orbit only while the canvas itself is focused, so arrows stay
  // free for manual play; damping follows reduced-motion changes live.
  renderer.domElement.tabIndex = 0;
  controls.listenToKeyEvents(renderer.domElement);
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncDamping = () => {
    controls.enableDamping = !motionQuery.matches;
  };
  syncDamping();
  motionQuery.addEventListener('change', syncDamping);

  const actorUpdates = new Set<(dt: number, elapsed: number) => void>();
  let lastTime = performance.now();
  let frame = 0;
  // ---- Follow camera (manual play) ----
  // Entering play eases from the overview to a chase view around the player,
  // keeping the author's viewing angle; afterwards the camera translates with
  // the player, so orbiting and zooming stay in the author's hands.
  let followTarget: THREE.Object3D | null = null;
  let followEnabled = true;
  const followLast = new THREE.Vector3();
  const chaseFrom = { target: new THREE.Vector3(), position: new THREE.Vector3() };
  const chaseTo = { target: new THREE.Vector3(), position: new THREE.Vector3() };
  let chaseProgress = 1;
  // Play sits close enough to read the character; replays pull back so the
  // route trail ahead stays in view.
  const chaseFraming = (): { distance: number; elevation: number } =>
    followTarget?.userData.chase === 'replay'
      ? { distance: 2100, elevation: THREE.MathUtils.degToRad(46) }
      : { distance: 1250, elevation: THREE.MathUtils.degToRad(34) };
  const beginChase = (): void => {
    if (followTarget === null) return;
    const focus = followTarget.position.clone();
    const { distance, elevation } = chaseFraming();
    const view = camera.position.clone().sub(controls.target);
    const horizontal = Math.hypot(view.x, view.z) || 1;
    const chaseDir = new THREE.Vector3(
      (view.x / horizontal) * Math.cos(elevation),
      Math.sin(elevation),
      (view.z / horizontal) * Math.cos(elevation),
    );
    chaseFrom.target.copy(controls.target);
    chaseFrom.position.copy(camera.position);
    chaseTo.target.copy(focus);
    chaseTo.position.copy(focus).addScaledVector(chaseDir, distance);
    followLast.copy(focus);
    chaseProgress = reducedMotion() ? 1 : 0;
    if (chaseProgress === 1) {
      controls.target.copy(chaseTo.target);
      camera.position.copy(chaseTo.position);
    }
  };
  const updateFollow = (dt: number): void => {
    if (followTarget === null || !followEnabled) return;
    const focus = followTarget.position;
    if (chaseProgress < 1) {
      chaseProgress = Math.min(1, chaseProgress + dt / 0.8);
      const t = chaseProgress * chaseProgress * (3 - 2 * chaseProgress);
      const shift = focus.clone().sub(chaseTo.target);
      chaseTo.target.add(shift);
      chaseTo.position.add(shift);
      controls.target.lerpVectors(chaseFrom.target, chaseTo.target, t);
      camera.position.lerpVectors(chaseFrom.position, chaseTo.position, t);
    } else {
      const delta = focus.clone().sub(followLast);
      camera.position.add(delta);
      controls.target.add(delta);
    }
    followLast.copy(focus);
  };
  // Camera-relative controls: which world direction is "forward" on screen.
  const computeFacing = (): Cardinal => {
    const fx = controls.target.x - camera.position.x;
    const fz = controls.target.z - camera.position.z;
    return Math.abs(fz) >= Math.abs(fx) ? (fz < 0 ? 'N' : 'S') : fx > 0 ? 'E' : 'W';
  };
  let facing: Cardinal = computeFacing();
  let facingHandler: ((facing: Cardinal) => void) | null = null;

  // Adaptive quality: after warm-up, sustained slow frames first lower the
  // render resolution, then drop terrain shadows and particles. Gameplay,
  // the diorama, and every overlay are unaffected.
  let qualityLevel = 0;
  let warmupFrames = 40;
  let sampledFrames = 0;
  let slowFrames = 0;
  const adaptQuality = (frameMs: number): void => {
    if (qualityLevel >= 2) return;
    if (warmupFrames > 0) {
      warmupFrames -= 1;
      return;
    }
    sampledFrames += 1;
    if (frameMs > 34) slowFrames += 1;
    if (sampledFrames < 45) return;
    if (slowFrames > 30) {
      qualityLevel += 1;
      if (qualityLevel === 1 && renderer.getPixelRatio() > 1) {
        renderer.setPixelRatio(1);
        renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
      } else {
        qualityLevel = 2;
        scenery.reduceDetail();
      }
      warmupFrames = 20;
    }
    sampledFrames = 0;
    slowFrames = 0;
  };
  const tick = () => {
    const now = performance.now();
    adaptQuality(now - lastTime);
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    for (const update of actorUpdates) update(dt, now);
    for (const update of decorUpdates) update(dt, now);
    updateFollow(dt);
    controls.update();
    const nextFacing = computeFacing();
    if (nextFacing !== facing) {
      facing = nextFacing;
      facingHandler?.(facing);
    }
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  let disposed = false;

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    cachedFit = computeFit();
    scenery.setFogRange(cachedFit);
    if (followTarget === null || !followEnabled) frameHome();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  // Recovery-analysis overlays (§7.2.3 viz): translucent floor decals.
  // Unlit materials so the tint reads identically in light and shadow.
  const analysisGroup = new THREE.Group();
  analysisGroup.visible = false;
  scene.add(analysisGroup);
  const analysisMats = {
    stranded: new THREE.MeshBasicMaterial({
      color: 0xd57064,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
    unreachable: new THREE.MeshBasicMaterial({
      color: 0x101216,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  };
  let analysisVisible = true;
  const overlayFor = (moduleId: string, material: THREE.MeshBasicMaterial): THREE.Mesh | null => {
    const m = compiled.moduleById.get(moduleId);
    if (!m) return null;
    const c = centerPoint(m);
    const size = GEOMETRY.cellPitchCm - 16;
    const geometry = new THREE.PlaneGeometry(size, size);
    geometry.rotateX(-Math.PI / 2);
    if (m.template === 'ramp') {
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i), z = positions.getZ(i);
        const along = m.orientation === 'N' ? -z : m.orientation === 'S' ? z : m.orientation === 'E' ? x : -x;
        positions.setY(i, along * GEOMETRY.floorSpacingCm / GEOMETRY.cellPitchCm);
      }
      geometry.computeVertexNormals();
    }
    const quad = new THREE.Mesh(geometry, material);
    quad.position.set(c.x, c.y + 3, c.z);
    return quad;
  };

  // ---- Repair preview markers (§9 before/after) ----
  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  scene.add(previewGroup);
  const previewMats = {
    old: new THREE.MeshBasicMaterial({ color: 0xd57064, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    fresh: new THREE.MeshBasicMaterial({ color: 0x4fbe82, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  };
  const previewTileMats = {
    old: new THREE.MeshBasicMaterial({ color: 0xd57064, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    fresh: new THREE.MeshBasicMaterial({ color: 0x4fbe82, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
  };
  const previewDoorMats = {
    old: new THREE.MeshBasicMaterial({ color: 0xd57064, transparent: true, opacity: 0.95, wireframe: true }),
    fresh: new THREE.MeshBasicMaterial({ color: 0x4fbe82, transparent: true, opacity: 0.98, wireframe: true }),
  };
  const ringAt = (x: number, y: number, z: number, material: THREE.Material, scale = 1): void => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(30, 48, 28), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 4, z);
    ring.scale.setScalar(scale);
    previewGroup.add(ring);
  };
  const positionInLevel = (level: Level, id: string): Vec3 | null => {
    const module = level.modules.find((item) => item.id === id);
    if (module) return centerPoint(module);
    const item = [...level.keys, ...level.switches].find((entry) => entry.id === id);
    if (item) {
      const owner = level.modules.find((entry) => entry.id === item.moduleId);
      return owner ? centerPoint(owner) : null;
    }
    const door = level.doors.find((entry) => entry.id === id);
    if (door !== undefined) {
      const a = level.modules.find((entry) => entry.id === door.a);
      const b = level.modules.find((entry) => entry.id === door.b);
      if (a && b) {
        const ca = centerPoint(a);
        const cb = centerPoint(b);
        return { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, z: (ca.z + cb.z) / 2 };
      }
    }
    return null;
  };

  const propMarkerPosition = (level: Level, marker: PreviewMarker): Vec3 | null => {
    if (marker.cell === undefined) return null;
    const host = level.modules
      .filter((module) => module.x === marker.cell!.x && module.z === marker.cell!.z)
      .sort((a, b) => b.h - a.h)[0];
    const x = marker.cell.x * GEOMETRY.cellPitchCm + GEOMETRY.cellPitchCm / 2;
    const z = marker.cell.z * GEOMETRY.cellPitchCm + GEOMETRY.cellPitchCm / 2;
    return { x, y: host ? centerPoint(host).y : GROUND_Y, z };
  };

  const moduleWash = (level: Level, id: string, material: THREE.Material): THREE.Mesh | null => {
    const module = level.modules.find((entry) => entry.id === id);
    if (module === undefined) return null;
    const size = GEOMETRY.cellPitchCm - 18;
    const geometry = new THREE.PlaneGeometry(size, size, 4, 4);
    geometry.rotateX(-Math.PI / 2);
    if (module.template === 'ramp') {
      const positions = geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index);
        const z = positions.getZ(index);
        const along = module.orientation === 'N' ? -z : module.orientation === 'S' ? z : module.orientation === 'E' ? x : -x;
        positions.setY(index, along * GEOMETRY.floorSpacingCm / GEOMETRY.cellPitchCm);
      }
      geometry.computeVertexNormals();
    }
    const center = centerPoint(module);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(center.x, center.y + 7, center.z);
    return mesh;
  };

  const doorFrameAt = (level: Level, doorId: string, material: THREE.Material): THREE.Mesh | null => {
    const door = level.doors.find((entry) => entry.id === doorId);
    const a = door && level.modules.find((entry) => entry.id === door.a);
    const b = door && level.modules.find((entry) => entry.id === door.b);
    if (!door || !a || !b) return null;
    const ca = centerPoint(a);
    const cb = centerPoint(b);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(230, 250, 34), material);
    frame.position.set((ca.x + cb.x) / 2, (ca.y + cb.y) / 2 + 125, (ca.z + cb.z) / 2);
    if (Math.abs(cb.x - ca.x) > Math.abs(cb.z - ca.z)) frame.rotation.y = Math.PI / 2;
    return frame;
  };

  const clearPreview = (): void => {
    for (const child of [...previewGroup.children]) {
      previewGroup.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    previewGroup.visible = false;
  };

  const stillInPlace = (before: Level, after: Level, marker: PreviewMarker): boolean => {
    if (marker.kind === 'module') {
      const a = before.modules.find((m) => m.id === marker.id);
      const b = after.modules.find((m) => m.id === marker.id);
      return a !== undefined && b !== undefined && a.x === b.x && a.z === b.z && a.h === b.h;
    }
    if (marker.kind === 'item') {
      const find = (level: Level) => [...level.keys, ...level.switches].find((item) => item.id === marker.id)?.moduleId;
      return find(before) !== undefined && find(before) === find(after);
    }
    if (marker.kind === 'door') return after.doors.some((door) => door.id === marker.id);
    return false;
  };

  const buildPreview = (preview: PreviewState): void => {
    clearPreview();
    // The state layer validates the complete candidate before it reaches the
    // renderer. A stale preview is ignored rather than re-applied locally;
    // this is what keeps atomic rule changes (remove key + requirement) intact.
    // The scene may show either side of the edit: the base with markers, or
    // (for AI proposals) the candidate itself. Anything else is stale.
    if (preview.baseRevision !== compiled.revisionId && revisionId(preview.candidate) !== compiled.revisionId) return;
    const { before, candidate: after } = preview;
    // When the scene already shows the proposal itself, green "added" rings
    // only add clutter: keep a soft wash on new floors and red markers for
    // what the proposal removes or moves away.
    const showingCandidate = compiled.revisionId !== preview.baseRevision;
    for (const marker of previewDiff(before, after)) {
      const level = marker.phase === 'old' ? before : after;
      const material = marker.phase === 'old' ? previewMats.old : previewMats.fresh;
      // On the proposal itself, "old" markers only mean something for what
      // is gone or has moved; an entity changed in place is already visible.
      if (showingCandidate && marker.phase === 'old' && stillInPlace(before, after, marker)) continue;
      if (showingCandidate && marker.phase === 'fresh') {
        if (marker.kind === 'module') {
          const wash = moduleWash(level, marker.id, previewTileMats.fresh);
          if (wash) previewGroup.add(wash);
        }
        continue;
      }
      if (marker.kind === 'prop') {
        const p = propMarkerPosition(level, marker);
        if (p) ringAt(p.x, p.y, p.z, material, 1.4);
        continue;
      }
      const a = positionInLevel(level, marker.moduleId);
      if (!a) continue;
      if (marker.kind === 'module') {
        const wash = moduleWash(level, marker.id, marker.phase === 'old' ? previewTileMats.old : previewTileMats.fresh);
        if (wash) previewGroup.add(wash);
        ringAt(a.x, a.y, a.z, material, 3.25);
        continue;
      }
      if (marker.kind === 'door' && marker.otherModuleId !== undefined) {
        const frame = doorFrameAt(level, marker.id, marker.phase === 'old' ? previewDoorMats.old : previewDoorMats.fresh);
        if (frame) previewGroup.add(frame);
        else {
          const b = positionInLevel(level, marker.otherModuleId);
          if (b) ringAt((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, material, 1.6);
        }
      } else if (marker.kind === 'item') {
        // Keep the authored item silhouette unobscured; a floor halo marks
        // the change without enclosing keys in an oversized wireframe sphere.
        ringAt(a.x, a.y + 18, a.z, material, 1.7);
      } else {
        ringAt(a.x, a.y, a.z, material, 1.5);
      }
    }
    previewGroup.visible = previewGroup.children.length > 0;
  };

  // ---- Selection (§12 "select, then describe") ----
  const selectionGroup = new THREE.Group();
  selectionGroup.visible = false;
  scene.add(selectionGroup);
  const selectionMat = new THREE.MeshBasicMaterial({
    color: 0xc9a227,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const protectedGroup = new THREE.Group();
  protectedGroup.visible = false;
  scene.add(protectedGroup);
  const protectedMat = new THREE.MeshBasicMaterial({
    color: 0xf2eee4,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
  });
  const protectedRingAt = (x: number, y: number, z: number): void => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(74, 88, 32), protectedMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 5, z);
    protectedGroup.add(ring);
  };
  const evidenceGroup = new THREE.Group();
  evidenceGroup.visible = false;
  scene.add(evidenceGroup);
  const evidenceMat = new THREE.MeshBasicMaterial({
    color: 0xe0a24b,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const evidenceOutlineMat = new THREE.MeshBasicMaterial({ color: 0xe0a24b, transparent: true, opacity: 0.95, wireframe: true });
  const evidenceRingAt = (x: number, y: number, z: number): void => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(92, 106, 32), evidenceMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 6, z);
    evidenceGroup.add(ring);
  };
  const evidenceDoorAt = (level: Level, id: string): boolean => {
    const door = level.doors.find((entry) => entry.id === id);
    const a = door && level.modules.find((entry) => entry.id === door.a);
    const b = door && level.modules.find((entry) => entry.id === door.b);
    if (!door || !a || !b) return false;
    const ca = centerPoint(a);
    const cb = centerPoint(b);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(240, 260, 36), evidenceOutlineMat);
    frame.position.set((ca.x + cb.x) / 2, (ca.y + cb.y) / 2 + 130, (ca.z + cb.z) / 2);
    if (Math.abs(cb.x - ca.x) > Math.abs(cb.z - ca.z)) frame.rotation.y = Math.PI / 2;
    evidenceGroup.add(frame);
    return true;
  };
  const evidenceObjectAt = (id: string): void => {
    const key = compiled.level.keys.find((entry) => entry.id === id);
    if (key !== undefined) {
      const owner = compiled.moduleById.get(key.moduleId);
      if (!owner) return;
      const center = centerPoint(owner);
      const outline = new THREE.Mesh(new THREE.SphereGeometry(140, 12, 8), evidenceOutlineMat);
      outline.position.set(center.x, center.y + 105, center.z);
      evidenceGroup.add(outline);
      return;
    }
    if (compiled.level.doors.some((entry) => entry.id === id) && evidenceDoorAt(compiled.level, id)) return;
    const center = entityPosition(id);
    if (center) evidenceRingAt(center.x, center.y, center.z);
  };
  let pickHandler: ((id: string | null) => void) | null = null;
  const selectionRingAt = (x: number, y: number, z: number, scale = 1): void => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(52, 68, 32), selectionMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 5, z);
    ring.scale.setScalar(scale);
    selectionGroup.add(ring);
  };
  const entityPosition = (id: string): Vec3 | null => {
    const module = compiled.moduleById.get(id);
    if (module) return centerPoint(module);
    const key = compiled.level.keys.find((k) => k.id === id);
    if (key) {
      const m = compiled.moduleById.get(key.moduleId);
      return m ? centerPoint(m) : null;
    }
    const pad = compiled.level.switches.find((sw) => sw.id === id);
    if (pad) {
      const m = compiled.moduleById.get(pad.moduleId);
      return m ? centerPoint(m) : null;
    }
    const door = compiled.level.doors.find((d) => d.id === id);
    if (door) {
      const a = compiled.moduleById.get(door.a);
      const b = compiled.moduleById.get(door.b);
      if (a && b) {
        const ca = centerPoint(a);
        const cb = centerPoint(b);
        return { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, z: (ca.z + cb.z) / 2 };
      }
    }
    const landmark = scenery.landmarks.find((entry) => entry.id === id);
    if (landmark) return { x: landmark.base.x, y: landmark.base.y, z: landmark.base.z };
    return null;
  };
  const raycaster = new THREE.Raycaster();
  const pointerDown = { x: 0, y: 0, active: false };
  const onPointerDown = (event: PointerEvent): void => {
    pointerDown.x = event.clientX;
    pointerDown.y = event.clientY;
    pointerDown.active = true;
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!pointerDown.active) return;
    pointerDown.active = false;
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    if (dx * dx + dy * dy > 25) return; // a drag orbits; a click selects
    if (pickHandler === null) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(world, true);
    const hit = hits[0]?.object ?? null;
    if (hit === null) {
      pickHandler(null);
      return;
    }
    pickHandler(meshToEntity.get(hit) ?? null);
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // ---- Engine-driven world state (§12 visible mechanism state) ----
  // The engine decides openness: doorPassable() against the live actor
  // state. Keyed doors rest locked; sealing doors rest open and slam shut
  // the moment their switch fires — the viewer sees the trap happen.
  const mechanisms = createMechanisms(compiled, visuals, reducedMotion, playSound);
  decorUpdates.push(mechanisms.update);

  const actorContext: ActorContext = {
    scene,
    compiled,
    register: (update) => {
      actorUpdates.add(update);
      return () => actorUpdates.delete(update);
    },
    follow: (target) => {
      // Actors opt in: the player (close) and verifier replays (wider).
      if (target !== null && target.userData.chase === undefined) return;
      if (target === null) {
        // Leaving play returns to the overview; a replay ending changes nothing.
        if (followTarget !== null) frameHome();
        followTarget = null;
        return;
      }
      followTarget = target;
      if (followEnabled) beginChase();
    },
    world: mechanisms.events,
    viewer: () => camera.position,
    characterWaitMs: 1500,
  };

  return {
    frameLevel: frameHome,
    spawnGhost(route, kind, missingKeys, callbacks, pauseAfterMoveIndex) {
      return new GhostActor(actorContext, route, kind, missingKeys, callbacks, pauseAfterMoveIndex);
    },
    setAnalysis(map) {
      for (const child of [...analysisGroup.children]) {
        analysisGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      if (map === null) {
        analysisGroup.visible = false;
        return;
      }
      for (const id of map.stranded) {
        const quad = overlayFor(id, analysisMats.stranded);
        if (quad) analysisGroup.add(quad);
      }
      for (const id of map.unreachable) {
        const quad = overlayFor(id, analysisMats.unreachable);
        if (quad) analysisGroup.add(quad);
      }
      analysisGroup.visible = analysisVisible && analysisGroup.children.length > 0;
    },
    setAnalysisVisible(visible) {
      analysisVisible = visible;
      analysisGroup.visible = visible && analysisGroup.children.length > 0;
    },
    previewOperations(preview) {
      if (preview === null) {
        clearPreview();
        return;
      }
      buildPreview(preview);
    },
    onPick(handler) {
      pickHandler = handler;
    },
    setSelection(ids) {
      for (const child of [...selectionGroup.children]) {
        selectionGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      for (const id of ids) {
        const c = entityPosition(id);
        if (c) selectionRingAt(c.x, c.y, c.z);
      }
      selectionGroup.visible = selectionGroup.children.length > 0;
    },
    setProtected(ids) {
      for (const child of [...protectedGroup.children]) {
        protectedGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      for (const id of ids) {
        const c = entityPosition(id);
        if (c) protectedRingAt(c.x, c.y, c.z);
      }
      protectedGroup.visible = protectedGroup.children.length > 0;
    },
    setEvidence(ids) {
      for (const child of [...evidenceGroup.children]) {
        evidenceGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      for (const id of ids) evidenceObjectAt(id);
      evidenceGroup.visible = evidenceGroup.children.length > 0;
    },
    spawnPlayer(callbacks) {
      return new PlayerActor(actorContext, callbacks);
    },
    setFollow(enabled) {
      if (followEnabled === enabled) return;
      followEnabled = enabled;
      if (enabled) beginChase();
      else frameHome();
    },
    onFacing(handler) {
      facingHandler = handler;
      handler?.(facing);
    },
    setKeyboardOrbit(enabled) {
      if (enabled) {
        controls.listenToKeyEvents(renderer.domElement);
      } else {
        controls.stopListenToKeyEvents();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // A theme change tears down the old renderer before React binds the new
      // one. Ignore any pointer-up that was already queued against this
      // canvas; otherwise a late empty hit can clear the store's selection
      // during the remount and make the UI/ring disappear.
      pickHandler = null;
      facingHandler = null;
      pointerDown.active = false;
      cancelAnimationFrame(frame);
      motionQuery.removeEventListener('change', syncDamping);
      observer.disconnect();
      controls.dispose();
      const shared = new Set<THREE.Material>(Object.values(mats));
      const disposeAll = (root: THREE.Object3D): void => {
        root.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const material = obj.material as THREE.Material | THREE.Material[];
            for (const m of Array.isArray(material) ? material : [material]) {
              if (!shared.has(m)) m.dispose();
            }
          }
        });
      };
      disposeAll(world);
      disposeAll(stage);
      scenery.dispose();
      for (const overlay of [analysisGroup, previewGroup, selectionGroup, protectedGroup, evidenceGroup]) {
        for (const child of [...overlay.children]) {
          overlay.remove(child);
          if (child instanceof THREE.Mesh) child.geometry.dispose();
        }
      }
      analysisMats.stranded.dispose();
      analysisMats.unreachable.dispose();
      previewMats.old.dispose();
      previewMats.fresh.dispose();
      previewTileMats.old.dispose();
      previewTileMats.fresh.dispose();
      previewDoorMats.old.dispose();
      previewDoorMats.fresh.dispose();
      selectionMat.dispose();
      protectedMat.dispose();
      evidenceMat.dispose();
      evidenceOutlineMat.dispose();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      for (const material of shared) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
