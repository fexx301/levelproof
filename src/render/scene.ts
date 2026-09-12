import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MoveRecord } from '../core/movement.js';
import { CARDINALS, type Cardinal, type Door, type LevelModule } from '../../shared/schema.js';
import { GEOMETRY, centerPoint, dirDelta, portPoint, type Vec3 } from '../core/catalog.js';
import { neighbor, type CompiledLevel } from '../core/topology.js';
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
 * the core uses. Camera follows actors with a dt-normalized lerp and snaps
 * instantly under reduced motion.
 */

const COLORS = {
  background: 0x101216,
  floor: 0x8d8577,
  bridge: 0x7c8a94,
  ramp: 0x9a8f7d,
  wall: 0x6a655a,
  rail: 0x47433c,
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

const WALL_HEIGHT_CM = 120;
const RAIL_HEIGHT_CM = 60;
const WALL_THICKNESS_CM = 24;
const DOOR_POST_HEIGHT_CM = 170;

interface Mats {
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

function buildMats(): Mats {
  return {
    floor: standard(COLORS.floor),
    bridge: standard(COLORS.bridge),
    ramp: standard(COLORS.ramp),
    wall: standard(COLORS.wall),
    rail: standard(COLORS.rail),
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
  spawnGhost(
    route: MoveRecord[],
    kind: 'solution' | 'bypass' | 'dead_end',
    missingKeys: string[],
    callbacks: GhostCallbacks,
  ): GhostActor;
  spawnPlayer(callbacks: PlayerCallbacks): PlayerActor;
  /** Arrow-key orbiting is disabled while manual play owns the arrows. */
  setKeyboardOrbit(enabled: boolean): void;
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
): void {
  const c = centerPoint(m);
  const half = GEOMETRY.cellPitchCm / 2;
  const { dx, dz } = dirDelta(dir);
  const alongX = dz !== 0;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(
      alongX ? GEOMETRY.cellPitchCm : WALL_THICKNESS_CM,
      height,
      alongX ? WALL_THICKNESS_CM : GEOMETRY.cellPitchCm,
    ),
    material,
  );
  mesh.position.set(c.x + dx * half, c.y + height / 2, c.z + dz * half);
  world.add(mesh);
}

function addModule(world: THREE.Group, mats: Mats, compiled: CompiledLevel, m: LevelModule): void {
  const c = centerPoint(m);
  if (m.template === 'ramp') {
    const slope = Math.hypot(GEOMETRY.cellPitchCm, GEOMETRY.floorSpacingCm);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(GEOMETRY.cellPitchCm, GEOMETRY.floorSlabThicknessCm, slope),
      mats.ramp,
    );
    const angle = Math.atan2(GEOMETRY.floorSpacingCm, GEOMETRY.cellPitchCm);
    if (m.orientation === 'N') mesh.rotation.x = angle;
    else if (m.orientation === 'S') mesh.rotation.x = -angle;
    else if (m.orientation === 'E') mesh.rotation.z = angle;
    else mesh.rotation.z = -angle;
    mesh.position.set(c.x, c.y, c.z);
    world.add(mesh);
    return; // the slope form reads as closed sides; polished rails later
  }

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(
      GEOMETRY.cellPitchCm,
      GEOMETRY.floorSlabThicknessCm,
      GEOMETRY.cellPitchCm,
    ),
    m.template === 'bridge' ? mats.bridge : mats.floor,
  );
  mesh.position.set(c.x, c.y - GEOMETRY.floorSlabThicknessCm / 2, c.z);
  world.add(mesh);

  // Closed sides get walls; open sides with no connection get visible edge
  // protection — unmatched openings are legal but impassable (§4.1).
  for (const dir of CARDINALS) {
    if (!m.ports.includes(dir)) {
      addEdgeBlock(world, m, dir, WALL_HEIGHT_CM, mats.wall);
    } else if (neighbor(compiled, m.id, dir) === null) {
      addEdgeBlock(world, m, dir, RAIL_HEIGHT_CM, mats.rail);
    }
  }
}

function doorMaterial(mats: Mats, door: Door): THREE.MeshStandardMaterial {
  const conditions = door.conditions;
  if (conditions?.requiresKey !== undefined) return mats.doorKey;
  if (conditions?.closesAfterSwitch !== undefined) return mats.doorSeal;
  return mats.doorPlain;
}

/** Door frame: two posts, a lintel, and a sill across the shared port. */
function addDoorFrames(world: THREE.Group, mats: Mats, compiled: CompiledLevel): void {
  for (const door of compiled.level.doors) {
    const material = doorMaterial(mats, door);
    for (const dir of CARDINALS) {
      if (neighbor(compiled, door.a, dir)?.toId !== door.b) continue;
      const a = compiled.moduleById.get(door.a);
      if (!a) continue;
      const p = portPoint(a, dir);
      const alongX = dir === 'N' || dir === 'S';
      const offset = GEOMETRY.portWidthCm / 2 + WALL_THICKNESS_CM / 2;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICKNESS_CM, DOOR_POST_HEIGHT_CM, WALL_THICKNESS_CM),
          material,
        );
        post.position.set(
          p.x + (alongX ? side * offset : 0),
          p.y + DOOR_POST_HEIGHT_CM / 2,
          p.z + (alongX ? 0 : side * offset),
        );
        world.add(post);
      }
      const span = GEOMETRY.portWidthCm + 2 * WALL_THICKNESS_CM;
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
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? GEOMETRY.portWidthCm : 12, 10, alongX ? 12 : GEOMETRY.portWidthCm),
        material,
      );
      sill.position.set(p.x, p.y + 5, p.z);
      world.add(sill);
      // Type telegraph: a keyhole gem on keyed doors, a warning bar on seals.
      const conditions = door.conditions;
      if (conditions?.requiresKey !== undefined) {
        const gem = new THREE.Mesh(
          new THREE.OctahedronGeometry(12),
          new THREE.MeshBasicMaterial({ color: 0xe8c65a, transparent: true, opacity: 0.6 }),
        );
        gem.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM + 24, p.z);
        world.add(gem);
      } else if (conditions?.closesAfterSwitch !== undefined) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(alongX ? span * 0.72 : 14, 10, alongX ? 14 : span * 0.72),
          new THREE.MeshBasicMaterial({ color: 0x9e3d35, transparent: true, opacity: 0.85 }),
        );
        bar.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM + 22, p.z);
        world.add(bar);
      }
      break; // exactly one direction joins the two endpoints
    }
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
): void {
  for (const key of compiled.level.keys) {
    const m = compiled.moduleById.get(key.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const group = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(26, 9, 10, 20), mats.key);
    bow.position.x = -36;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(72, 12, 12), mats.key);
    shaft.position.x = 8;
    for (const [x, h] of [
      [28, 24],
      [8, 18],
    ] as const) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(12, h, 12), mats.key);
      tooth.position.set(x, -6 - h / 2, 0);
      group.add(tooth);
    }
    group.add(bow, shaft);
    group.scale.setScalar(1.6);
    const baseY = c.y + 105;
    group.position.set(c.x, baseY, c.z);
    world.add(group);
    decorUpdates.push((dt, elapsed) => {
      if (reducedMotion()) return;
      group.rotation.y += dt * 0.7;
      group.position.y = baseY + Math.sin(elapsed * 0.002) * 8;
    });
  }
  for (const pad of compiled.level.switches) {
    const m = compiled.moduleById.get(pad.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(78, 88, 12, 28), mats.wall);
    base.position.set(c.x, c.y + 6, c.z);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(46, 50, 16, 24), mats.switchPad);
    plate.position.set(c.x, c.y + 14, c.z);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(64, 6, 8, 32), mats.switchRim);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(c.x, c.y + 12, c.z);
    world.add(base, plate, rim);
  }
  const spawn = compiled.moduleById.get(compiled.spawn);
  if (spawn) {
    const c = centerPoint(spawn);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 8, 32), mats.spawn);
    mesh.position.set(c.x, c.y + 4, c.z);
    world.add(mesh);
  }
  const goal = compiled.moduleById.get(compiled.goal);
  if (goal) {
    const c = centerPoint(goal);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(50, 62, 36, 24), mats.wall);
    pedestal.position.set(c.x, c.y + 18, c.z);
    world.add(pedestal);
    const beacon = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(40), mats.goal);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(72, 5, 8, 40), mats.goalHalo);
    halo.rotation.x = Math.PI / 2;
    beacon.add(gem, halo);
    const baseY = c.y + 130;
    beacon.position.set(c.x, baseY, c.z);
    // Three.js >= r155 uses physical light units; at cm scale, decay-1 with
    // intensity ~= desired illuminance at 1 unit keeps pools readable.
    beacon.add(new THREE.PointLight(COLORS.goal, 320, 1700, 1));
    world.add(beacon);
    decorUpdates.push((dt, elapsed) => {
      if (reducedMotion()) return;
      beacon.rotation.y += dt * 0.6;
      beacon.position.y = baseY + Math.sin(elapsed * 0.0016) * 10;
    });
  }
}

export function mountScene(host: HTMLElement, compiled: CompiledLevel): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const mats = buildMats();
  const world = new THREE.Group();
  scene.add(world);
  for (const m of compiled.level.modules) {
    addModule(world, mats, compiled, m);
  }
  addDoorFrames(world, mats, compiled);
  const decorUpdates: DecorUpdate[] = [];
  addItems(world, mats, compiled, decorUpdates);
  // Everything solid casts and receives; upper floors shadow lower ones.
  world.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Lighting: warm key light with real shadows, cool sky fill, faint ambient.
  scene.add(new THREE.HemisphereLight(0x505662, 0x2a241c, 0.8));
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));
  const center = layoutCenter(compiled);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
  sun.position.set(center.x - 2200, 5200, center.z + 1600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 500;
  sun.shadow.camera.far = 20000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 12;
  scene.add(sun);
  scene.add(sun.target);

  // Fit-to-level framing: frame the level's bounding sphere so the diorama
  // fills the viewport instead of floating in margins. The view direction
  // keeps the original elevated southeast azimuth.
  let boundsRadius = 800;
  let boundsMin = new THREE.Vector3(-800, -300, -800);
  let boundsMax = new THREE.Vector3(800, 300, 800);
  {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const half = GEOMETRY.cellPitchCm / 2 + WALL_THICKNESS_CM;
    for (const m of compiled.level.modules) {
      const c = centerPoint(m);
      minX = Math.min(minX, c.x - half);
      maxX = Math.max(maxX, c.x + half);
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y + DOOR_POST_HEIGHT_CM + 60);
      minZ = Math.min(minZ, c.z - half);
      maxZ = Math.max(maxZ, c.z + half);
    }
    if (Number.isFinite(minX)) {
      const home = new THREE.Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
      );
      boundsRadius = Math.max(
        half,
        home.distanceTo(new THREE.Vector3(minX, minY, minZ)),
      );
      boundsMin.set(minX, minY, minZ);
      boundsMax.set(maxX, maxY, maxZ);
      // Shadow camera covers the level with margin, centered on it.
      const s = boundsRadius + 600;
      sun.shadow.camera.left = -s;
      sun.shadow.camera.right = s;
      sun.shadow.camera.top = s;
      sun.shadow.camera.bottom = -s;
      sun.target.position.copy(home);
      sun.target.updateMatrixWorld();
    }
  }
  // A stage under the level: the diorama casts onto it, grounding the scene.
  const stage = new THREE.Mesh(
    new THREE.CircleGeometry(boundsRadius * 1.55, 48),
    new THREE.MeshStandardMaterial({ color: 0x17191f, roughness: 0.95 }),
  );
  stage.rotation.x = -Math.PI / 2;
  stage.position.set(center.x, -60, center.z);
  stage.receiveShadow = true;
  scene.add(stage);

  const viewDir = new THREE.Vector3(1500, 2600, 3900).normalize();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 10, 60000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI / 2.05;
  const homeTarget = new THREE.Vector3(center.x, center.y, center.z);
  const corners: THREE.Vector3[] = [];
  const computeFit = (): number => {
    corners.length = 0;
    const half = GEOMETRY.cellPitchCm / 2 + WALL_THICKNESS_CM;
    for (const m of compiled.level.modules) {
      const c = centerPoint(m);
      for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
          corners.push(new THREE.Vector3(c.x + dx, c.y, c.z + dz));
          corners.push(new THREE.Vector3(c.x + dx, c.y + DOOR_POST_HEIGHT_CM + 60, c.z + dz));
        }
      }
    }
    if (corners.length === 0) {
      for (const x of [boundsMin.x, boundsMax.x]) {
        for (const y of [boundsMin.y, boundsMax.y]) {
          for (const z of [boundsMin.z, boundsMax.z]) corners.push(new THREE.Vector3(x, y, z));
        }
      }
    }
    // Same ray, any distance: the camera quaternion stays valid while only
    // the position slides along the view direction.
    const saved = camera.position.clone();
    const extentAt = (d: number): number => {
      camera.position.copy(homeTarget).addScaledVector(viewDir, d);
      camera.updateMatrixWorld();
      let maxExt = 0;
      for (const c of corners) {
        const p = c.clone().project(camera);
        maxExt = Math.max(maxExt, Math.abs(p.x), Math.abs(p.y));
      }
      return maxExt;
    };
    let lo = 400;
    let hi = 60000;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (extentAt(mid) > 0.92) lo = mid;
      else hi = mid;
    }
    const d = (lo + hi) / 2;
    camera.position.copy(saved);
    camera.updateMatrixWorld();
    return d;
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
  let followTarget: THREE.Object3D | null = null;
  let distanceControl = false;
  let lastTime = performance.now();
  let frame = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    for (const update of actorUpdates) update(dt, now);
    for (const update of decorUpdates) update(dt, now);
    if (followTarget !== null) {
      // Following an actor: keep it centered and pull in close enough that
      // the actor reads — the route stays in frame, the ghost is the focus.
      distanceControl = true;
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 5);
      controls.target.lerp(followTarget.position, k);
      const desired = fitDistance() * 0.3;
      const offset = camera.position.clone().sub(controls.target);
      const current = offset.length() || 1;
      offset.multiplyScalar(THREE.MathUtils.lerp(current, desired, k) / current);
      camera.position.copy(controls.target).add(offset);
    } else if (distanceControl) {
      // Follow ended: glide back to the framed overview, then hand control
      // back to the user (their zoom/orbit is never fought otherwise).
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 4);
      controls.target.lerp(homeTarget, k);
      const desired = fitDistance();
      const offset = camera.position.clone().sub(controls.target);
      const current = offset.length() || 1;
      offset.multiplyScalar(THREE.MathUtils.lerp(current, desired, k) / current);
      camera.position.copy(controls.target).add(offset);
      if (Math.abs(current - desired) < 2 && controls.target.distanceTo(homeTarget) < 2) {
        distanceControl = false;
      }
    }
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    cachedFit = computeFit();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  const actorContext: ActorContext = {
    scene,
    compiled,
    register: (update) => {
      actorUpdates.add(update);
      return () => actorUpdates.delete(update);
    },
    follow: (target) => {
      followTarget = target;
    },
  };

  return {
    spawnGhost(route, kind, missingKeys, callbacks) {
      return new GhostActor(actorContext, route, kind, missingKeys, callbacks);
    },
    spawnPlayer(callbacks) {
      return new PlayerActor(actorContext, callbacks);
    },
    setKeyboardOrbit(enabled) {
      if (enabled) {
        controls.listenToKeyEvents(renderer.domElement);
      } else {
        controls.stopListenToKeyEvents();
      }
    },
    dispose() {
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
      for (const material of shared) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
