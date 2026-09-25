import * as THREE from 'three';
import type { KeyLook, PropKind } from '../../shared/schema.js';

/**
 * Procedural scenery meshes (cosmetic only). Everything is built from Three.js
 * primitives at the catalog's centimeter scale — no imported or AI-generated
 * assets. The engine never reads any of this: a dragon is a statue, not an
 * enemy, and the preview says so.
 */

/** Scatter-only kinds the environment adds around the diorama. */
export type ScatterKind =
  | PropKind
  | 'flowers'
  | 'reeds'
  | 'stalagmite'
  | 'building'
  | 'asteroid'
  | 'lava-pool'
  | 'pond'
  | 'snow-pine';

export interface PropContext {
  /** Snowy caps on trees and rocks. */
  snowy: boolean;
  /** Light-emitting parts glow harder in the dark. */
  dark: boolean;
  /** Architecture accent (banners, throne cushion, console screens). */
  accent: number;
  /** Stone color matching the architecture palette. */
  stone: number;
  /** Crystal tint for the environment (ice blue, magma red, cavern violet). */
  crystal?: number;
  mats: MaterialCache;
}

export interface BuiltProp {
  group: THREE.Group;
  /** A warm/cool light this prop would cast at night, relative to the group. */
  glow?: { color: number; offset: THREE.Vector3; strength: number };
  /** Idle animation (flames, water, portals); skipped under reduced motion. */
  update?: (dt: number, elapsed: number) => void;
  /** Large props should not be placed where they hide the puzzle. */
  tall: boolean;
}

interface MatOptions {
  rough?: number;
  metal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flat?: boolean;
  transparent?: number;
}

/** Scene-scoped material cache: many props share a handful of materials. */
export class MaterialCache {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();

  get(color: number, options: MatOptions = {}): THREE.MeshStandardMaterial {
    const key = JSON.stringify([color, options]);
    let material = this.cache.get(key);
    if (material === undefined) {
      material = new THREE.MeshStandardMaterial({
        color,
        roughness: options.rough ?? 0.85,
        metalness: options.metal ?? 0,
        flatShading: options.flat ?? false,
        ...(options.emissive !== undefined
          ? { emissive: options.emissive, emissiveIntensity: options.emissiveIntensity ?? 1 }
          : {}),
        ...(options.transparent !== undefined ? { transparent: true, opacity: options.transparent } : {}),
      });
      this.cache.set(key, material);
    }
    return material;
  }

  all(): THREE.Material[] {
    return [...this.cache.values()];
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}

/** Deterministic pseudo-random stream (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

/** Jitter a geometry's vertices for a hand-cut, low-poly look. */
function roughen(geometry: THREE.BufferGeometry, amount: number, random: () => number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  // Weld-safe: displace by a function of the vertex position, so shared
  // corners stay shared and the silhouette never cracks open.
  const offsets = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(2)}|${position.getY(i).toFixed(2)}|${position.getZ(i).toFixed(2)}`;
    let offset = offsets.get(key);
    if (offset === undefined) {
      offset = 1 + (random() - 0.5) * amount;
      offsets.set(key, offset);
    }
    position.setXYZ(i, position.getX(i) * offset, position.getY(i) * offset, position.getZ(i) * offset);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function flame(ctx: PropContext, scale = 1): { group: THREE.Group; update: (dt: number, elapsed: number) => void } {
  const group = new THREE.Group();
  const outer = mesh(new THREE.ConeGeometry(14 * scale, 46 * scale, 7), ctx.mats.get(0xff8a2a, { emissive: 0xff6a10, emissiveIntensity: ctx.dark ? 2.6 : 1.6, rough: 1 }), 0, 23 * scale, 0);
  const inner = mesh(new THREE.ConeGeometry(8 * scale, 30 * scale, 6), ctx.mats.get(0xffe08a, { emissive: 0xffd060, emissiveIntensity: ctx.dark ? 3 : 2, rough: 1 }), 0, 16 * scale, 0);
  outer.castShadow = false;
  inner.castShadow = false;
  group.add(outer, inner);
  const phase = Math.random() * 10;
  return {
    group,
    update: (_dt, elapsed) => {
      const t = elapsed * 0.012 + phase;
      const flicker = 1 + Math.sin(t) * 0.08 + Math.sin(t * 2.7) * 0.06;
      group.scale.set(1 / Math.sqrt(flicker), flicker, 1 / Math.sqrt(flicker));
      group.rotation.y = Math.sin(t * 0.7) * 0.4;
    },
  };
}

function tree(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const bark = ctx.mats.get(0x5b4330, { flat: true });
  const leaf = ctx.mats.get(ctx.snowy ? 0x5f7a66 : [0x4f7a3a, 0x5d8a3f, 0x6b8f3a][Math.floor(random() * 3)]!, { flat: true });
  group.add(mesh(new THREE.CylinderGeometry(14, 22, 220, 7), bark, 0, 110, 0));
  const blobs: Array<[number, number, number, number]> = [[0, 300, 0, 120], [60, 250, 30, 85], [-55, 260, -25, 90], [10, 360, -10, 80]];
  for (const [x, y, z, r] of blobs) {
    group.add(mesh(roughen(new THREE.IcosahedronGeometry(r, 1), 0.25, random), leaf, x, y, z));
    if (ctx.snowy) group.add(mesh(new THREE.SphereGeometry(r * 0.72, 8, 5, 0, Math.PI * 2, 0, Math.PI / 3), ctx.mats.get(0xf2f5f8, { flat: true }), x, y + r * 0.35, z));
  }
  return { group, tall: true };
}

function pine(ctx: PropContext, random: () => number, snowy = ctx.snowy): BuiltProp {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(12, 18, 120, 6), ctx.mats.get(0x4d3a2a, { flat: true }), 0, 60, 0));
  const needles = ctx.mats.get(random() > 0.5 ? 0x2f5a3c : 0x355f40, { flat: true });
  const snow = ctx.mats.get(0xf4f7fa, { flat: true });
  const tiers: Array<[number, number, number]> = [[150, 170, 110], [118, 150, 230], [80, 130, 340]];
  for (const [radius, height, y] of tiers) {
    group.add(mesh(new THREE.ConeGeometry(radius, height, 7), needles, 0, y, 0));
    if (snowy) group.add(mesh(new THREE.ConeGeometry(radius * 0.62, height * 0.42, 7), snow, 0, y + height * 0.3, 0));
  }
  return { group, tall: true };
}

function deadTree(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const bark = ctx.mats.get(0x3b342f, { flat: true });
  group.add(mesh(new THREE.CylinderGeometry(10, 24, 320, 6), bark, 0, 160, 0));
  for (let i = 0; i < 5; i++) {
    const branch = mesh(new THREE.CylinderGeometry(3, 8, 130 + random() * 60, 5), bark);
    const angle = random() * Math.PI * 2;
    branch.position.set(Math.cos(angle) * 34, 200 + i * 26, Math.sin(angle) * 34);
    branch.rotation.set(Math.sin(angle) * 0.9, 0, -Math.cos(angle) * 0.9);
    group.add(branch);
  }
  return { group, tall: true };
}

function palm(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const bark = ctx.mats.get(0x8a6a44, { flat: true });
  const lean = 0.18 + random() * 0.1;
  let y = 0;
  let x = 0;
  for (let i = 0; i < 7; i++) {
    const segment = mesh(new THREE.CylinderGeometry(15 - i, 18 - i, 72, 6), bark, x, y + 36, 0);
    segment.rotation.z = -lean;
    group.add(segment);
    y += 70;
    x += 72 * Math.sin(lean);
  }
  const frond = ctx.mats.get(0x4e8a3c, { flat: true });
  for (let i = 0; i < 7; i++) {
    const leaf = mesh(new THREE.ConeGeometry(30, 230, 4), frond);
    leaf.scale.set(1, 1, 0.25);
    const angle = (i / 7) * Math.PI * 2;
    // Point each frond's apex outward and slightly down from the crown.
    leaf.position.set(x + Math.cos(angle) * 90, y - 10, Math.sin(angle) * 90);
    leaf.lookAt(x + Math.cos(angle) * 300, y - 120, Math.sin(angle) * 300);
    leaf.rotateX(Math.PI / 2);
    group.add(leaf);
  }
  return { group, tall: true };
}

function bush(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const leaf = ctx.mats.get(ctx.snowy ? 0x6f8577 : 0x4d7a3c, { flat: true });
  for (let i = 0; i < 3; i++) {
    group.add(mesh(roughen(new THREE.IcosahedronGeometry(44 + random() * 22, 0), 0.3, random), leaf, (random() - 0.5) * 70, 36, (random() - 0.5) * 70));
  }
  return { group, tall: false };
}

function rock(ctx: PropContext, random: () => number, color = 0x7a756c): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(color, { flat: true, rough: 0.95 });
  const boulder = mesh(roughen(new THREE.DodecahedronGeometry(70 + random() * 40, 0), 0.35, random), stone, 0, 38, 0);
  boulder.scale.y = 0.65;
  group.add(boulder);
  if (random() > 0.4) group.add(mesh(roughen(new THREE.DodecahedronGeometry(34, 0), 0.4, random), stone, 70, 18, 30));
  if (ctx.snowy) {
    const cap = mesh(new THREE.SphereGeometry(62, 7, 4, 0, Math.PI * 2, 0, Math.PI / 3.2), ctx.mats.get(0xf4f7fa, { flat: true }), 0, 58, 0);
    cap.scale.y = 0.5;
    group.add(cap);
  }
  return { group, tall: false };
}

function crystal(ctx: PropContext, random: () => number, color = 0x7fd8ff): BuiltProp {
  const group = new THREE.Group();
  const glass = ctx.mats.get(color, { emissive: color, emissiveIntensity: ctx.dark ? 1.4 : 0.55, rough: 0.2, metal: 0.1, flat: true });
  for (let i = 0; i < 4; i++) {
    const shard = mesh(new THREE.OctahedronGeometry(30, 0), glass);
    shard.scale.set(0.7, 2.8 + random() * 1.6, 0.7);
    shard.position.set((random() - 0.5) * 70, 70 + random() * 30, (random() - 0.5) * 70);
    shard.rotation.set((random() - 0.5) * 0.7, random() * Math.PI, (random() - 0.5) * 0.7);
    group.add(shard);
  }
  group.add(mesh(roughen(new THREE.DodecahedronGeometry(46, 0), 0.3, random), ctx.mats.get(0x4a4652, { flat: true }), 0, 12, 0));
  return { group, glow: { color, offset: new THREE.Vector3(0, 110, 0), strength: 0.7 }, tall: false };
}

function mushroom(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const glowCap = ctx.dark;
  for (let i = 0; i < 3; i++) {
    const height = 40 + random() * 60;
    const x = (random() - 0.5) * 80;
    const z = (random() - 0.5) * 80;
    group.add(mesh(new THREE.CylinderGeometry(7, 10, height, 6), ctx.mats.get(0xe8dfcf), x, height / 2, z));
    const capColor = glowCap ? 0x7ff0c8 : random() > 0.5 ? 0xb8443a : 0xc9763a;
    const cap = mesh(
      new THREE.SphereGeometry(26 + random() * 14, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      ctx.mats.get(capColor, glowCap ? { emissive: capColor, emissiveIntensity: 1.2 } : {}),
      x, height, z,
    );
    group.add(cap);
  }
  return { group, ...(glowCap ? { glow: { color: 0x7ff0c8, offset: new THREE.Vector3(0, 80, 0), strength: 0.45 } } : {}), tall: false };
}

function cactus(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const skin = ctx.mats.get(0x4f7d45, { flat: true });
  group.add(mesh(new THREE.CapsuleGeometry(26, 200, 4, 8), skin, 0, 126, 0));
  for (const side of [-1, 1]) {
    if (random() > 0.75) continue;
    const arm = mesh(new THREE.CapsuleGeometry(17, 70, 4, 8), skin, side * 58, 150 + random() * 40, 0);
    group.add(arm, mesh(new THREE.CapsuleGeometry(15, 30, 4, 8), skin, side * 32, 118 + random() * 10, 0));
    group.children.at(-1)!.rotation.z = side * Math.PI / 2;
  }
  return { group, tall: true };
}

function brazier(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const iron = ctx.mats.get(0x3a332d, { metal: 0.6, rough: 0.5 });
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.CylinderGeometry(4, 5, 110, 5), iron, Math.cos(angle) * 22, 52, Math.sin(angle) * 22);
    leg.rotation.set(Math.sin(angle) * 0.22, 0, -Math.cos(angle) * 0.22);
    group.add(leg);
  }
  group.add(mesh(new THREE.CylinderGeometry(42, 26, 30, 10, 1, true), iron, 0, 112, 0));
  group.add(mesh(new THREE.CylinderGeometry(38, 38, 6, 10), ctx.mats.get(0x6a2a10, { emissive: 0xff5010, emissiveIntensity: 0.9 }), 0, 118, 0));
  const fire = flame(ctx, 1.4);
  fire.group.position.y = 118;
  group.add(fire.group);
  return { group, glow: { color: 0xff8a3a, offset: new THREE.Vector3(0, 170, 0), strength: 1 }, update: fire.update, tall: false };
}

function torch(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(6, 8, 170, 6), ctx.mats.get(0x5a4230), 0, 85, 0));
  group.add(mesh(new THREE.CylinderGeometry(16, 9, 22, 8), ctx.mats.get(0x3a332d, { metal: 0.5 }), 0, 176, 0));
  const fire = flame(ctx, 1.1);
  fire.group.position.y = 184;
  group.add(fire.group);
  return { group, glow: { color: 0xff9a4a, offset: new THREE.Vector3(0, 220, 0), strength: 0.8 }, update: fire.update, tall: false };
}

function lantern(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const iron = ctx.mats.get(0x2f2c29, { metal: 0.6, rough: 0.45 });
  group.add(mesh(new THREE.CylinderGeometry(5, 7, 150, 6), iron, 0, 75, 0));
  group.add(mesh(new THREE.BoxGeometry(34, 44, 34), ctx.mats.get(0xffd58a, { emissive: 0xffc060, emissiveIntensity: ctx.dark ? 2.2 : 0.9, transparent: 0.92 }), 0, 170, 0));
  group.add(mesh(new THREE.ConeGeometry(28, 22, 4), iron, 0, 203, 0));
  group.children.at(-1)!.rotation.y = Math.PI / 4;
  return { group, glow: { color: 0xffc070, offset: new THREE.Vector3(0, 170, 0), strength: 0.7 }, tall: false };
}

function campfire(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(0x6c665e, { flat: true });
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2;
    group.add(mesh(roughen(new THREE.DodecahedronGeometry(13, 0), 0.3, random), stone, Math.cos(angle) * 58, 8, Math.sin(angle) * 58));
  }
  const wood = ctx.mats.get(0x4b3423);
  for (let i = 0; i < 3; i++) {
    const log = mesh(new THREE.CylinderGeometry(7, 7, 90, 6), wood, 0, 14, 0);
    log.rotation.set(Math.PI / 2, (i / 3) * Math.PI, 0.25);
    group.add(log);
  }
  const fire = flame(ctx, 1.6);
  fire.group.position.y = 12;
  group.add(fire.group);
  return { group, glow: { color: 0xff8030, offset: new THREE.Vector3(0, 70, 0), strength: 1.1 }, update: fire.update, tall: false };
}

function candles(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const wax = ctx.mats.get(0xeee4cc);
  const updates: Array<(dt: number, elapsed: number) => void> = [];
  for (let i = 0; i < 5; i++) {
    const height = 20 + random() * 30;
    const x = (random() - 0.5) * 60;
    const z = (random() - 0.5) * 60;
    group.add(mesh(new THREE.CylinderGeometry(6, 6, height, 8), wax, x, height / 2, z));
    const fire = flame(ctx, 0.35);
    fire.group.position.set(x, height, z);
    group.add(fire.group);
    updates.push(fire.update);
  }
  return {
    group,
    glow: { color: 0xffb060, offset: new THREE.Vector3(0, 50, 0), strength: 0.45 },
    update: (dt, elapsed) => updates.forEach((update) => update(dt, elapsed)),
    tall: false,
  };
}

function banner(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const pole = ctx.mats.get(0x3a332d, { metal: 0.4 });
  group.add(mesh(new THREE.CylinderGeometry(5, 6, 340, 6), pole, 0, 170, 0));
  group.add(mesh(new THREE.CylinderGeometry(4, 4, 110, 6), pole, 0, 320, 0));
  group.children.at(-1)!.rotation.z = Math.PI / 2;
  const cloth = new THREE.PlaneGeometry(100, 190, 1, 6);
  const clothMesh = mesh(cloth, new THREE.MeshStandardMaterial({ color: ctx.accent, roughness: 0.9, side: THREE.DoubleSide }), 0, 222, 3);
  const emblem = mesh(new THREE.CircleGeometry(22, 6), new THREE.MeshStandardMaterial({ color: 0xe8c867, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide }), 0, 240, 5);
  group.add(clothMesh, emblem);
  const phase = Math.random() * 6;
  return {
    group,
    update: (_dt, elapsed) => {
      clothMesh.rotation.y = Math.sin(elapsed * 0.0015 + phase) * 0.18;
      emblem.rotation.y = clothMesh.rotation.y;
    },
    tall: true,
  };
}

function statue(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(ctx.stone, { rough: 0.9 });
  const dark = ctx.mats.get(0x6f6a62, { rough: 0.9 });
  group.add(mesh(new THREE.BoxGeometry(110, 50, 110), dark, 0, 25, 0));
  group.add(mesh(new THREE.BoxGeometry(90, 10, 90), stone, 0, 55, 0));
  for (const side of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(24, 80, 28), stone, side * 16, 100, 0));
  group.add(mesh(new THREE.BoxGeometry(64, 78, 36), stone, 0, 178, 0));
  group.add(mesh(new THREE.BoxGeometry(84, 18, 40), stone, 0, 212, 0));
  group.add(mesh(new THREE.SphereGeometry(20, 10, 8), stone, 0, 240, 0));
  group.add(mesh(new THREE.ConeGeometry(22, 26, 8), stone, 0, 262, 0));
  const sword = mesh(new THREE.BoxGeometry(8, 150, 4), ctx.mats.get(0xa9a9a4, { metal: 0.6, rough: 0.4 }), 0, 128, 34);
  const guard = mesh(new THREE.BoxGeometry(40, 6, 8), stone, 0, 196, 34);
  const shield = mesh(new THREE.CylinderGeometry(30, 30, 8, 10), dark, -46, 168, 12);
  shield.rotation.z = Math.PI / 2;
  group.add(sword, guard, shield);
  return { group, tall: true };
}

function dragon(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  // Verdigris bronze reads as a statue in daylight and still catches moonlight.
  const scale = ctx.mats.get(0x5f8a6e, { rough: 0.5, metal: 0.45, flat: true, emissive: 0x0f1a14, emissiveIntensity: ctx.dark ? 1 : 0 });
  const belly = ctx.mats.get(0xb09a62, { rough: 0.6, metal: 0.3, flat: true });
  const horn = ctx.mats.get(0xd8cfb8, { rough: 0.6 });
  const plinth = ctx.mats.get(ctx.stone, { rough: 0.95 });
  const eye = ctx.mats.get(0xff5a2a, { emissive: 0xff3a10, emissiveIntensity: ctx.dark ? 3 : 1.6 });
  group.add(mesh(new THREE.BoxGeometry(250, 36, 150), plinth, 0, 18, 0));

  // Crouched body, facing +z.
  const body = mesh(new THREE.SphereGeometry(60, 12, 9), scale, 0, 110, -10);
  body.scale.set(0.95, 0.8, 1.55);
  const underside = mesh(new THREE.SphereGeometry(54, 10, 8), belly, 0, 98, -2);
  underside.scale.set(0.8, 0.62, 1.4);
  group.add(body, underside);

  // Legs, bent at the knee.
  for (const [x, z] of [[-44, 48], [44, 48], [-46, -62], [46, -62]] as const) {
    group.add(mesh(new THREE.CylinderGeometry(15, 12, 62, 7), scale, x, 66, z));
    group.add(mesh(new THREE.BoxGeometry(30, 12, 40), scale, x, 42, z + 10));
  }

  // Neck and head rearing up toward the viewer.
  const neck = mesh(new THREE.CylinderGeometry(18, 30, 120, 8), scale, 0, 180, 70);
  neck.rotation.x = 0.55;
  group.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 240, 118);
  head.add(mesh(new THREE.BoxGeometry(46, 40, 56), scale, 0, 0, 0));
  const snout = mesh(new THREE.BoxGeometry(36, 26, 52), scale, 0, -6, 46);
  const jaw = mesh(new THREE.BoxGeometry(32, 10, 48), belly, 0, -22, 40);
  jaw.rotation.x = 0.18;
  head.add(snout, jaw);
  for (const side of [-1, 1]) {
    const h = mesh(new THREE.ConeGeometry(7, 52, 6), horn, side * 16, 30, -20);
    h.rotation.x = -0.9;
    h.rotation.z = side * -0.25;
    head.add(h, mesh(new THREE.SphereGeometry(5, 6, 6), eye, side * 17, 8, 22));
  }
  group.add(head);

  // Spined tail curling around the plinth.
  const tailPoints = [
    new THREE.Vector3(0, 108, -90), new THREE.Vector3(30, 80, -140), new THREE.Vector3(90, 50, -120),
    new THREE.Vector3(120, 44, -50), new THREE.Vector3(110, 42, 20),
  ];
  for (let i = 0; i < tailPoints.length - 1; i++) {
    const from = tailPoints[i]!;
    const to = tailPoints[i + 1]!;
    const length = from.distanceTo(to);
    const segment = mesh(new THREE.CylinderGeometry(22 - i * 5, 26 - i * 5, length, 7), scale);
    segment.position.copy(from).add(to).multiplyScalar(0.5);
    segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    group.add(segment);
  }
  const tip = mesh(new THREE.ConeGeometry(12, 40, 4), horn, 104, 42, 44);
  tip.rotation.x = Math.PI / 2;
  group.add(tip);

  // Membrane wings raised in a threat display.
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.lineTo(210, 150);
  wingShape.lineTo(175, 60);
  wingShape.lineTo(190, 10);
  wingShape.lineTo(120, 20);
  wingShape.lineTo(110, -20);
  wingShape.lineTo(40, -10);
  wingShape.lineTo(0, 0);
  const membrane = new THREE.MeshStandardMaterial({ color: 0x8a4a3e, roughness: 0.75, side: THREE.DoubleSide, flatShading: true });
  for (const side of [-1, 1]) {
    const wing = mesh(new THREE.ShapeGeometry(wingShape), membrane, side * 30, 140, -20);
    wing.scale.x = side;
    wing.rotation.set(-0.35, side * 0.5, side * 0.35);
    group.add(wing);
  }
  // Dorsal spines.
  for (let i = 0; i < 5; i++) {
    const spine = mesh(new THREE.ConeGeometry(9, 30, 4), horn, 0, 150 - i * 6, 40 - i * 28);
    group.add(spine);
  }
  return { group, glow: { color: 0xff5a2a, offset: new THREE.Vector3(0, 250, 130), strength: 0.35 }, tall: true };
}

function column(ctx: PropContext, height: number, broken: boolean, random: () => number): THREE.Group {
  const group = new THREE.Group();
  const stone = ctx.mats.get(ctx.stone, { rough: 0.9, flat: broken });
  group.add(mesh(new THREE.BoxGeometry(84, 24, 84), stone, 0, 12, 0));
  group.add(mesh(new THREE.CylinderGeometry(34, 34, 14, 16), stone, 0, 31, 0));
  const shaft = new THREE.CylinderGeometry(28, 32, height, 12, broken ? 3 : 1);
  if (broken) {
    const position = shaft.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) > height / 2 - 1) position.setY(i, position.getY(i) - random() * 60);
    }
    shaft.computeVertexNormals();
  }
  group.add(mesh(shaft, stone, 0, 38 + height / 2, 0));
  if (!broken) {
    group.add(mesh(new THREE.CylinderGeometry(40, 32, 18, 16), stone, 0, 46 + height, 0));
    group.add(mesh(new THREE.BoxGeometry(92, 18, 92), stone, 0, 64 + height, 0));
  }
  return group;
}

function pillar(ctx: PropContext, random: () => number): BuiltProp {
  return { group: column(ctx, 300, false, random), tall: true };
}

function ruin(ctx: PropContext, random: () => number): BuiltProp {
  const group = column(ctx, 150 + random() * 80, true, random);
  const stone = ctx.mats.get(ctx.stone, { rough: 0.9, flat: true });
  const drum = mesh(new THREE.CylinderGeometry(30, 30, 60, 12), stone, 90, 30, 30);
  drum.rotation.z = Math.PI / 2;
  drum.rotation.y = random();
  group.add(drum, mesh(roughen(new THREE.BoxGeometry(60, 34, 44, 1, 1, 1), 0.2, random), stone, -70, 17, 60));
  return { group, tall: false };
}

function gravestone(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(0x8a8780, { rough: 0.95, flat: true });
  const slab = mesh(new THREE.BoxGeometry(60, 80, 16), stone, 0, 40, 0);
  const top = mesh(new THREE.CylinderGeometry(30, 30, 16, 12, 1, false, 0, Math.PI), stone, 0, 80, 0);
  top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  const tilt = (random() - 0.5) * 0.25;
  slab.rotation.z = tilt;
  top.rotation.y = tilt;
  const mound = mesh(new THREE.SphereGeometry(50, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), ctx.mats.get(0x4b4336, { flat: true }), 0, 0, 55);
  mound.scale.set(0.8, 0.25, 1.4);
  group.add(slab, top, mound);
  return { group, tall: false };
}

function chest(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const wood = ctx.mats.get(0x6b4524, { rough: 0.8 });
  const brass = ctx.mats.get(0xd4af37, { metal: 0.8, rough: 0.35, emissive: 0x6b5010, emissiveIntensity: 0.3 });
  group.add(mesh(new THREE.BoxGeometry(100, 56, 64), wood, 0, 28, 0));
  const lid = mesh(new THREE.CylinderGeometry(32, 32, 100, 12, 1, false, 0, Math.PI), wood, 0, 56, 0);
  lid.rotation.z = Math.PI / 2;
  group.add(lid);
  for (const x of [-34, 34]) group.add(mesh(new THREE.BoxGeometry(10, 60, 68), brass, x, 30, 0));
  group.add(mesh(new THREE.BoxGeometry(16, 18, 6), brass, 0, 48, 34));
  const gold = ctx.mats.get(0xf2c94c, { metal: 0.9, rough: 0.3, emissive: 0x8a6a10, emissiveIntensity: 0.4 });
  for (let i = 0; i < 9; i++) {
    const coin = mesh(new THREE.CylinderGeometry(8, 8, 3, 10), gold, -40 + i * 11, 2 + (i % 3) * 3, 48 + (i % 2) * 10);
    coin.rotation.x = (i % 3) * 0.3;
    group.add(coin);
  }
  return { group, glow: { color: 0xffd060, offset: new THREE.Vector3(0, 70, 30), strength: 0.3 }, tall: false };
}

function throne(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(ctx.stone, { rough: 0.85 });
  const gold = ctx.mats.get(0xd4af37, { metal: 0.85, rough: 0.3 });
  const cushion = ctx.mats.get(ctx.accent, { rough: 0.95 });
  group.add(mesh(new THREE.BoxGeometry(150, 20, 130), stone, 0, 10, 0));
  group.add(mesh(new THREE.BoxGeometry(100, 50, 80), stone, 0, 45, 0));
  group.add(mesh(new THREE.BoxGeometry(84, 12, 70), cushion, 0, 76, 4));
  group.add(mesh(new THREE.BoxGeometry(100, 190, 20), stone, 0, 145, -40));
  group.add(mesh(new THREE.BoxGeometry(70, 140, 8), cushion, 0, 140, -28));
  group.add(mesh(new THREE.ConeGeometry(28, 50, 4), gold, 0, 265, -40));
  for (const side of [-1, 1]) {
    group.add(mesh(new THREE.BoxGeometry(14, 40, 76), stone, side * 54, 90, 0));
    group.add(mesh(new THREE.SphereGeometry(12, 8, 6), gold, side * 54, 115, 34));
    group.add(mesh(new THREE.ConeGeometry(12, 40, 4), gold, side * 44, 258, -40));
  }
  return { group, tall: false };
}

function barrel(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const wood = ctx.mats.get(0x7a5230);
  const hoop = ctx.mats.get(0x3a3632, { metal: 0.6, rough: 0.5 });
  const count = random() > 0.5 ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const x = i * 70 - (count - 1) * 35;
    group.add(mesh(new THREE.CylinderGeometry(30, 30, 84, 12), wood, x, 42, 0));
    group.add(mesh(new THREE.CylinderGeometry(34, 34, 60, 12, 1, true), wood, x, 42, 0));
    for (const y of [14, 70]) group.add(mesh(new THREE.TorusGeometry(33, 3, 5, 14), hoop, x, y, 0));
    group.children.slice(-2).forEach((child) => { child.rotation.x = Math.PI / 2; });
  }
  return { group, tall: false };
}

function fountain(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(ctx.stone, { rough: 0.85 });
  const water = new THREE.MeshStandardMaterial({ color: 0x4aa3c8, roughness: 0.15, metalness: 0.1, emissive: 0x1a5a78, emissiveIntensity: 0.35, transparent: true, opacity: 0.88 });
  group.add(mesh(new THREE.CylinderGeometry(130, 140, 40, 20), stone, 0, 20, 0));
  const pool = mesh(new THREE.CylinderGeometry(118, 118, 6, 20), water, 0, 38, 0);
  group.add(pool);
  group.add(mesh(new THREE.CylinderGeometry(20, 28, 110, 10), stone, 0, 90, 0));
  group.add(mesh(new THREE.CylinderGeometry(60, 30, 24, 14), stone, 0, 150, 0));
  group.add(mesh(new THREE.CylinderGeometry(52, 52, 4, 14), water, 0, 162, 0));
  const spout = mesh(new THREE.ConeGeometry(16, 60, 8), water, 0, 190, 0);
  group.add(spout);
  return {
    group,
    update: (_dt, elapsed) => {
      spout.scale.y = 1 + Math.sin(elapsed * 0.006) * 0.12;
      water.emissiveIntensity = 0.3 + Math.sin(elapsed * 0.003) * 0.08;
    },
    tall: false,
  };
}

function portal(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(ctx.stone, { rough: 0.85 });
  group.add(mesh(new THREE.BoxGeometry(220, 24, 70), stone, 0, 12, 0));
  const ring = mesh(new THREE.TorusGeometry(110, 18, 10, 28), stone, 0, 140, 0);
  group.add(ring);
  const swirlMaterial = new THREE.MeshStandardMaterial({ color: 0x8a6cff, emissive: 0x6a4cff, emissiveIntensity: ctx.dark ? 2.2 : 1.2, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const swirl = mesh(new THREE.CircleGeometry(94, 24), swirlMaterial, 0, 140, 0);
  const core = mesh(new THREE.RingGeometry(30, 70, 20, 1, 0, Math.PI * 1.4), new THREE.MeshBasicMaterial({ color: 0xd8ccff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }), 0, 140, 1);
  group.add(swirl, core);
  for (const x of [-110, 110]) group.add(mesh(new THREE.OctahedronGeometry(14), ctx.mats.get(0xb49cff, { emissive: 0x8a6cff, emissiveIntensity: 1.5 }), x, 140, 0));
  return {
    group,
    glow: { color: 0x8a6cff, offset: new THREE.Vector3(0, 140, 40), strength: 1 },
    update: (dt) => { core.rotation.z -= dt * 1.6; },
    tall: true,
  };
}

function consoleProp(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const shell = ctx.mats.get(0x2c3942, { metal: 0.6, rough: 0.35 });
  group.add(mesh(new THREE.BoxGeometry(110, 80, 60), shell, 0, 40, 0));
  const top = mesh(new THREE.BoxGeometry(110, 10, 70), shell, 0, 86, 6);
  top.rotation.x = -0.35;
  const screen = mesh(new THREE.PlaneGeometry(90, 50), ctx.mats.get(ctx.accent, { emissive: ctx.accent, emissiveIntensity: ctx.dark ? 1.8 : 1 }), 0, 92, 12);
  screen.rotation.x = -0.35 - Math.PI / 2;
  screen.position.y = 93;
  group.add(top, screen);
  for (let i = 0; i < 4; i++) group.add(mesh(new THREE.BoxGeometry(10, 6, 6), ctx.mats.get([0xff5a4a, 0x5aff8a, 0xffd04a, 0x4ab0ff][i]!, { emissive: [0xff5a4a, 0x5aff8a, 0xffd04a, 0x4ab0ff][i]!, emissiveIntensity: 1.5 }), -30 + i * 20, 60, 31));
  return { group, glow: { color: ctx.accent, offset: new THREE.Vector3(0, 110, 30), strength: 0.5 }, tall: false };
}

function antenna(ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const metal = ctx.mats.get(0x8b9aa3, { metal: 0.7, rough: 0.35 });
  for (const [x, z] of [[-30, -30], [30, -30], [-30, 30], [30, 30]] as const) {
    const leg = mesh(new THREE.CylinderGeometry(4, 5, 420, 5), metal, x * 0.6, 210, z * 0.6);
    leg.rotation.set(z * -0.0012, 0, x * 0.0012);
    group.add(leg);
  }
  for (let y = 60; y < 400; y += 70) group.add(mesh(new THREE.BoxGeometry(46 - y * 0.06, 4, 46 - y * 0.06), metal, 0, y, 0));
  const dishMaterial = ctx.mats.get(0xd6dde2, { metal: 0.3, rough: 0.4 });
  const dish = mesh(new THREE.CylinderGeometry(72, 14, 26, 18, 1, true), dishMaterial, 0, 450, 26);
  dish.rotation.x = -1.0;
  const dishBack = mesh(new THREE.CircleGeometry(14, 12), dishMaterial, 0, 438, 20);
  const feed = mesh(new THREE.CylinderGeometry(2, 2, 70, 5), metal, 0, 468, 50);
  feed.rotation.x = -1.0;
  group.add(dish, dishBack, feed);
  const beacon = mesh(new THREE.SphereGeometry(10, 8, 6), ctx.mats.get(0xff4a3a, { emissive: 0xff2a1a, emissiveIntensity: 2 }), 0, 430, 0);
  group.add(beacon);
  return {
    group,
    glow: { color: 0xff4a3a, offset: new THREE.Vector3(0, 430, 0), strength: 0.4 },
    update: (_dt, elapsed) => { beacon.visible = Math.floor(elapsed / 700) % 2 === 0; },
    tall: true,
  };
}

const tileTextures = new Map<string, THREE.Texture | null>();

/** Small procedural texture: a cracked crust over molten light, or ripples. */
function tileTexture(kind: 'water' | 'lava' | 'lava-glow'): THREE.Texture | null {
  if (tileTextures.has(kind)) return tileTextures.get(kind)!;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  const random = seededRandom(kind === 'water' ? 7 : 11);
  if (kind === 'water') {
    context.fillStyle = '#3f86a8';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = 'rgba(220,240,255,0.35)';
    context.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const x = random() * 128;
      const y = random() * 128;
      context.beginPath();
      context.arc(x, y, 6 + random() * 14, Math.PI * 1.1, Math.PI * 1.9);
      context.stroke();
    }
  } else {
    // Crust plates separated by glowing seams (shared layout for both maps).
    context.fillStyle = kind === 'lava' ? '#ff7a2a' : '#ffffff';
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = kind === 'lava' ? '#2a1712' : '#000000';
    for (let i = 0; i < 16; i++) {
      const cx = (i % 4) * 32 + 16 + (random() - 0.5) * 8;
      const cy = Math.floor(i / 4) * 32 + 16 + (random() - 0.5) * 8;
      context.beginPath();
      for (let k = 0; k < 6; k++) {
        const angle = (k / 6) * Math.PI * 2;
        const radius = 11 + random() * 4;
        context[k === 0 ? 'moveTo' : 'lineTo'](cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
      context.closePath();
      context.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = kind === 'lava-glow' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  tileTextures.set(kind, texture);
  return texture;
}

/** Flat ground tile (water or lava) covering one grid cell. */
function groundTile(kind: 'water' | 'lava', ctx: PropContext): BuiltProp {
  const group = new THREE.Group();
  const waterMap = kind === 'water' ? tileTexture('water') : null;
  const lavaMap = kind === 'lava' ? tileTexture('lava') : null;
  const lavaGlow = kind === 'lava' ? tileTexture('lava-glow') : null;
  const material = kind === 'water'
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, ...(waterMap ? { map: waterMap } : { color: 0x3f86a8 }), roughness: 0.12, metalness: 0.15, emissive: 0x0f3a52, emissiveIntensity: ctx.dark ? 0.5 : 0.25, transparent: true, opacity: 0.92 })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, ...(lavaMap ? { map: lavaMap } : { color: 0xd2481a }), roughness: 0.8, emissive: 0xff5a14, ...(lavaGlow ? { emissiveMap: lavaGlow } : {}), emissiveIntensity: 1.6 });
  const tile = mesh(new THREE.PlaneGeometry(400, 400, 1, 1), material, 0, 3, 0);
  tile.rotation.x = -Math.PI / 2;
  tile.receiveShadow = true;
  group.add(tile);
  const phase = Math.random() * 10;
  return {
    group,
    ...(kind === 'lava' ? { glow: { color: 0xff5a1a, offset: new THREE.Vector3(0, 60, 0), strength: 0.9 } } : {}),
    update: (_dt, elapsed) => {
      material.emissiveIntensity = (kind === 'lava' ? 1.5 : ctx.dark ? 0.45 : 0.22) + Math.sin(elapsed * 0.002 + phase) * (kind === 'lava' ? 0.35 : 0.08);
    },
    tall: false,
  };
}

// ---- Scatter-only kinds ----

function flowers(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const stem = ctx.mats.get(0x4d7a3c);
  const colors = [0xe8d45a, 0xd86a8a, 0xf2efe6, 0x9a7ae0];
  for (let i = 0; i < 7; i++) {
    const x = (random() - 0.5) * 120;
    const z = (random() - 0.5) * 120;
    group.add(mesh(new THREE.CylinderGeometry(1.5, 1.5, 26, 4), stem, x, 13, z));
    group.add(mesh(new THREE.IcosahedronGeometry(7, 0), ctx.mats.get(colors[Math.floor(random() * colors.length)]!, { flat: true }), x, 27, z));
  }
  return { group, tall: false };
}

function reeds(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const reed = ctx.mats.get(0x6d7a45, { flat: true });
  for (let i = 0; i < 9; i++) {
    const height = 70 + random() * 70;
    const blade = mesh(new THREE.ConeGeometry(4, height, 3), reed, (random() - 0.5) * 70, height / 2, (random() - 0.5) * 70);
    blade.rotation.set((random() - 0.5) * 0.3, 0, (random() - 0.5) * 0.3);
    group.add(blade);
  }
  return { group, tall: false };
}

function stalagmite(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const stone = ctx.mats.get(0x57504a, { flat: true });
  for (let i = 0; i < 3; i++) {
    const height = 90 + random() * 180;
    group.add(mesh(roughen(new THREE.ConeGeometry(26 + random() * 20, height, 6), 0.15, random), stone, (random() - 0.5) * 90, height / 2, (random() - 0.5) * 90));
  }
  return { group, tall: true };
}

function building(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const height = 500 + random() * 900;
  const shell = ctx.mats.get(random() > 0.5 ? 0x2a3038 : 0x323a44, { metal: 0.3, rough: 0.6 });
  group.add(mesh(new THREE.BoxGeometry(300, height, 300), shell, 0, height / 2, 0));
  const windowMaterial = ctx.mats.get(ctx.accent, { emissive: ctx.accent, emissiveIntensity: ctx.dark ? 1.4 : 0.5 });
  for (let y = 80; y < height - 40; y += 90) {
    if (random() > 0.7) continue;
    for (const side of [-1, 1]) {
      group.add(mesh(new THREE.BoxGeometry(220, 14, 4), windowMaterial, 0, y, side * 151));
      group.add(mesh(new THREE.BoxGeometry(4, 14, 220), windowMaterial, side * 151, y, 0));
    }
  }
  return { group, tall: true };
}

function asteroid(ctx: PropContext, random: () => number): BuiltProp {
  const group = new THREE.Group();
  const rockMesh = mesh(roughen(new THREE.IcosahedronGeometry(60 + random() * 90, 1), 0.45, random), ctx.mats.get(0x5d5550, { flat: true, rough: 0.95 }));
  group.add(rockMesh);
  const spin = (random() - 0.5) * 0.3;
  return { group, update: (dt) => { rockMesh.rotation.y += dt * spin; rockMesh.rotation.x += dt * spin * 0.5; }, tall: false };
}

function pool(ctx: PropContext, random: () => number, lava: boolean): BuiltProp {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  const points = 9;
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const radius = 110 + random() * 70;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const lavaMap = lava ? tileTexture('lava') : null;
  const lavaGlow = lava ? tileTexture('lava-glow') : null;
  const material = lava
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, ...(lavaMap ? { map: lavaMap } : { color: 0xd2481a }), emissive: 0xff5a14, ...(lavaGlow ? { emissiveMap: lavaGlow } : {}), emissiveIntensity: 1.5, roughness: 0.8 })
    : ctx.mats.get(0x3a5a4a, { rough: 0.15, metal: 0.2, emissive: 0x0a2a22, emissiveIntensity: 0.3 });
  const surfaceGeometry = new THREE.ShapeGeometry(shape);
  // Shape UVs are in centimeters; one texture tile per grid cell.
  const uv = surfaceGeometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 400, uv.getY(i) / 400);
  const surface = mesh(surfaceGeometry, material, 0, 6, 0);
  surface.rotation.x = -Math.PI / 2;
  surface.receiveShadow = true;
  // A crust rim seats the pool in the terrain instead of floating on it.
  const rim = mesh(new THREE.ShapeGeometry(shape), ctx.mats.get(lava ? 0x1f1714 : 0x2f3a2a, { rough: 1, flat: true }), 0, 3, 0);
  rim.rotation.x = -Math.PI / 2;
  rim.scale.set(1.22, 1.22, 1);
  group.add(rim, surface);
  return { group, ...(lava ? { glow: { color: 0xff5a1a, offset: new THREE.Vector3(0, 60, 0), strength: 0.8 } } : {}), tall: false };
}

/** Build one prop or scatter object. The group's origin sits on its base. */
export function buildProp(kind: ScatterKind, ctx: PropContext, seed: number): BuiltProp {
  const random = seededRandom(seed);
  switch (kind) {
    case 'tree': return tree(ctx, random);
    case 'pine': return pine(ctx, random);
    case 'snow-pine': return pine(ctx, random, true);
    case 'dead-tree': return deadTree(ctx, random);
    case 'palm': return palm(ctx, random);
    case 'bush': return bush(ctx, random);
    case 'rock': return rock(ctx, random);
    case 'crystal': return crystal(ctx, random, ctx.crystal);
    case 'mushroom': return mushroom(ctx, random);
    case 'cactus': return cactus(ctx, random);
    case 'brazier': return brazier(ctx);
    case 'torch': return torch(ctx);
    case 'lantern': return lantern(ctx);
    case 'campfire': return campfire(ctx, random);
    case 'candles': return candles(ctx, random);
    case 'banner': return banner(ctx);
    case 'statue': return statue(ctx);
    case 'dragon': return dragon(ctx);
    case 'pillar': return pillar(ctx, random);
    case 'ruin': return ruin(ctx, random);
    case 'gravestone': return gravestone(ctx, random);
    case 'chest': return chest(ctx);
    case 'throne': return throne(ctx);
    case 'barrel': return barrel(ctx, random);
    case 'fountain': return fountain(ctx);
    case 'portal': return portal(ctx);
    case 'console': return consoleProp(ctx);
    case 'antenna': return antenna(ctx);
    case 'water': return groundTile('water', ctx);
    case 'lava': return groundTile('lava', ctx);
    case 'flowers': return flowers(ctx, random);
    case 'reeds': return reeds(ctx, random);
    case 'stalagmite': return stalagmite(ctx, random);
    case 'building': return building(ctx, random);
    case 'asteroid': return asteroid(ctx, random);
    case 'lava-pool': return pool(ctx, random, true);
    case 'pond': return pool(ctx, random, false);
  }
}

/**
 * Key silhouettes by look. Every look is centered on the origin like the
 * classic key so the float, spin, and collect animation stay identical.
 */
export function buildKeyLook(look: KeyLook, color: number, material: THREE.MeshStandardMaterial, dark: boolean): {
  parts: THREE.Object3D[];
  update?: (dt: number, elapsed: number) => void;
} {
  switch (look) {
    case 'key':
      return { parts: [] };
    case 'torch': {
      const handle = mesh(new THREE.CylinderGeometry(5, 7, 70, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 }), 0, -12, 0);
      const cup = mesh(new THREE.CylinderGeometry(12, 7, 14, 8), material, 0, 26, 0);
      const outer = mesh(new THREE.ConeGeometry(11, 36, 7), new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff6a10, emissiveIntensity: dark ? 2.6 : 1.7 }), 0, 50, 0);
      const inner = mesh(new THREE.ConeGeometry(6, 22, 6), new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffd060, emissiveIntensity: dark ? 3 : 2 }), 0, 44, 0);
      return {
        parts: [handle, cup, outer, inner],
        update: (_dt, elapsed) => {
          const flicker = 1 + Math.sin(elapsed * 0.013) * 0.09 + Math.sin(elapsed * 0.031) * 0.05;
          outer.scale.set(1, flicker, 1);
          inner.scale.set(1, 2 - flicker, 1);
        },
      };
    }
    case 'lantern': {
      const iron = new THREE.MeshStandardMaterial({ color: 0x2f2c29, metalness: 0.6, roughness: 0.45 });
      const glow = new THREE.MeshStandardMaterial({ color: 0xffd58a, emissive: 0xffc060, emissiveIntensity: dark ? 2.4 : 1.2, transparent: true, opacity: 0.92 });
      const cage = mesh(new THREE.BoxGeometry(30, 38, 30), glow);
      const cap = mesh(new THREE.ConeGeometry(24, 18, 4), iron, 0, 28, 0);
      cap.rotation.y = Math.PI / 4;
      const base = mesh(new THREE.BoxGeometry(34, 6, 34), iron, 0, -21, 0);
      const handle = mesh(new THREE.TorusGeometry(12, 2.5, 5, 14, Math.PI), iron, 0, 38, 0);
      return { parts: [cage, cap, base, handle] };
    }
    case 'gem': {
      const gem = mesh(new THREE.OctahedronGeometry(28, 0), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.15, metalness: 0.2, flatShading: true }));
      gem.scale.y = 1.4;
      return { parts: [gem] };
    }
    case 'orb': {
      const orb = mesh(new THREE.SphereGeometry(24, 18, 14), new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x4a9fe0, emissiveIntensity: dark ? 1.6 : 0.9, roughness: 0.1, transparent: true, opacity: 0.9 }));
      const ring = mesh(new THREE.TorusGeometry(34, 3, 6, 24), material);
      ring.rotation.x = Math.PI / 2.4;
      return { parts: [orb, ring] };
    }
    case 'crown': {
      const band = mesh(new THREE.CylinderGeometry(28, 26, 22, 16, 1, true), material);
      const points: THREE.Object3D[] = [band];
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        points.push(mesh(new THREE.ConeGeometry(6, 22, 4), material, Math.cos(angle) * 26, 20, Math.sin(angle) * 26));
        points.push(mesh(new THREE.SphereGeometry(4, 6, 4), new THREE.MeshStandardMaterial({ color: 0xd04a5a, emissive: 0x902030, emissiveIntensity: 0.5 }), Math.cos(angle) * 27, 0, Math.sin(angle) * 27));
      }
      return { parts: points };
    }
    case 'scroll': {
      const paper = new THREE.MeshStandardMaterial({ color: 0xe8dcb8, roughness: 0.9 });
      const roll = mesh(new THREE.CylinderGeometry(10, 10, 64, 12), paper);
      roll.rotation.z = Math.PI / 2;
      const ribbon = mesh(new THREE.TorusGeometry(11, 2.5, 5, 14), new THREE.MeshStandardMaterial({ color: 0xb03a3a }));
      ribbon.rotation.y = Math.PI / 2;
      const caps = [-36, 36].map((x) => {
        const cap = mesh(new THREE.CylinderGeometry(13, 13, 8, 12), material, x, 0, 0);
        cap.rotation.z = Math.PI / 2;
        return cap;
      });
      return { parts: [roll, ribbon, ...caps] };
    }
    case 'keycard': {
      const card = mesh(new THREE.BoxGeometry(64, 40, 4), new THREE.MeshStandardMaterial({ color: 0x2c3942, metalness: 0.4, roughness: 0.3 }));
      const stripe = mesh(new THREE.BoxGeometry(64, 8, 5), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 }), 0, 10, 0);
      const chip = mesh(new THREE.BoxGeometry(14, 12, 5), material, -18, -6, 0);
      return { parts: [card, stripe, chip] };
    }
    case 'amulet': {
      const chain = mesh(new THREE.TorusGeometry(30, 2, 5, 20), material, 0, 18, 0);
      const pendant = mesh(new THREE.CylinderGeometry(18, 18, 6, 6), material, 0, -12, 0);
      pendant.rotation.x = Math.PI / 2;
      const stone = mesh(new THREE.SphereGeometry(9, 10, 8), new THREE.MeshStandardMaterial({ color: 0x3ad0a0, emissive: 0x1a8a60, emissiveIntensity: 0.8 }), 0, -12, 4);
      return { parts: [chain, pendant, stone] };
    }
  }
}
