import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compileLevel } from '../src/core/topology';
import { trapLevel } from '../src/core/fixtures/trap';
import { initialState } from '../src/core/movement';
import { rampGeometry, framingPoints, fitOverview, sceneBounds } from '../src/render/craft';
import { artDirection, switchSignature } from '../src/render/art-direction';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../src/core/fixtures/gallery';
import { createMechanisms, type WorldVisuals } from '../src/render/mechanisms';
import type { Cardinal } from '../shared/schema';
import { GhostActor, PlayerActor, type ActorContext, type WorldEvents } from '../src/render/actors';
import { step } from '../src/core/movement';

function setup(reduced = false, switchOnly = false) {
  const level = structuredClone(trapLevel);
  if (switchOnly) level.doors[0]!.conditions = { requiresSwitch: 'seal-switch' };
  const compiled = compileLevel(level);
  const key = new THREE.Group();
  key.userData.baseY = 100;
  const plate = new THREE.Mesh();
  plate.userData.restY = 14;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(), new THREE.MeshStandardMaterial());
  const visuals: WorldVisuals = {
    keys: new Map([['brass-key', key]]),
    switches: new Map([['seal-switch', { plate, rim }]]),
    doors: new Map(level.doors.map(door => [door.id, { group: new THREE.Group(), closedY: 0, openY: 180, targetOpen: false }])),
  };
  const controller = createMechanisms(compiled, visuals, () => reduced);
  return { compiled, visuals, controller, key, plate };
}

describe('engine-driven mechanism visuals', () => {
  it('resolves the explicit futuristic direction as a complete palette', () => {
    const direction = artDirection(compileLevel(trapLevel), 'futuristic');
    expect(direction.name).toBe('Future vault');
    expect(direction.base).not.toBe(direction.floor);
    expect(direction.camera).toHaveLength(3);
  });

  it('gives harmless openers and sealing switches different shapes and colors', () => {
    const c = compileLevel(gauntletLevel);
    expect(switchSignature(c, 'gate-primer').sides).toBe(6);
    expect(switchSignature(c, 'vault-seal').sides).toBe(3);
    expect(switchSignature(c, 'gate-primer').color).not.toBe(switchSignature(c, 'vault-seal').color);
  });
  it('collects the key, opens its gate, depresses the plate and seals the return', () => {
    const { compiled, controller, visuals, key, plate } = setup();
    expect(visuals.doors.get('vault-door')!.group.position.y).toBe(0);
    expect(visuals.doors.get('gallery-door')!.group.position.y).toBe(180);
    controller.events.updateState({ ...initialState(compiled), keyMask: 1, switchMask: 1 });
    controller.update(2);
    expect(key.visible).toBe(false);
    expect(plate.position.y).toBeCloseTo(5);
    expect(visuals.doors.get('vault-door')!.group.position.y).toBe(180);
    expect(visuals.doors.get('gallery-door')!.group.position.y).toBe(0);
  });
  it('cancels an in-flight collection on restart', () => {
    const { compiled, controller, key } = setup();
    controller.events.updateState({ ...initialState(compiled), keyMask: 1 });
    controller.update(0.1);
    controller.events.resetWorld();
    controller.update(1);
    expect(key.visible).toBe(true);
    expect(key.scale.x).toBe(1.6);
    expect(key.position.y).toBe(100);
  });
  it('honors switch-only conditions in the initial state and reduced motion', () => {
    const { compiled, controller, visuals, plate } = setup(true, true);
    expect(visuals.doors.get('vault-door')!.group.position.y).toBe(0);
    controller.events.updateState({ ...initialState(compiled), switchMask: 1 });
    expect(visuals.doors.get('vault-door')!.group.position.y).toBe(180);
    expect(plate.position.y).toBe(5);
    controller.events.resetWorld();
    expect(plate.position.y).toBe(14);
    expect(visuals.doors.get('vault-door')!.group.position.y).toBe(0);
  });
  it('retracts a shutter into its header and restores its full leaf on reset', () => {
    const { controller, visuals, compiled } = setup(true);
    const door = visuals.doors.get('vault-door')!;
    door.group.userData.retracts = true;
    controller.events.updateState({ ...initialState(compiled), keyMask: 1 });
    expect(door.group.scale.y).toBe(0.025);
    controller.events.resetWorld();
    expect(door.group.position.y).toBe(0);
    expect(door.group.scale.y).toBe(1);
  });
});

describe('stable overview framing', () => {
  for (const [name, level] of [['vault', trapLevel], ['twins', twinKeysLevel], ['overpass', overpassLevel], ['gauntlet', gauntletLevel]] as const) {
    for (const width of [320, 375, 414, 768, 1280]) {
      it(`contains all ${name} structure at ${width}px without changing the current orbit`, () => {
        const camera = new THREE.PerspectiveCamera(45, width / 720, 10, 60000);
        camera.position.set(100, 200, 300);
        camera.lookAt(50, 50, 50);
        const before = camera.quaternion.clone();
        const points = framingPoints(level.modules);
        const target = sceneBounds(level.modules).getCenter(new THREE.Vector3());
        const direction = new THREE.Vector3(...artDirection(compileLevel(level)).camera).normalize();
        const distance = fitOverview(camera, target, direction, points);
        expect(camera.position.toArray()).toEqual([100, 200, 300]);
        expect(camera.quaternion.equals(before)).toBe(true);
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        for (const point of points) {
          const projected = point.clone().project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.871);
          expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.871);
          expect(projected.z).toBeLessThan(1);
        }
      });
    }
  }
});

describe('catalog-aligned ramp surfaces', () => {
  for (const orientation of ['N', 'E', 'S', 'W'] as Cardinal[]) {
    it(`${orientation} has a 400 cm footprint and exact 300 cm rise`, () => {
      const geometry = rampGeometry({ id: 'ramp', template: 'ramp', x: 0, z: 0, h: 0, ports: [], orientation });
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const along = orientation === 'N' ? -pos.getZ(i) : orientation === 'S' ? pos.getZ(i) : orientation === 'E' ? pos.getX(i) : -pos.getX(i);
        const offset = pos.getY(i) - along * 0.75;
        expect(offset === 0 || offset === -30).toBe(true);
      }
      expect(geometry.boundingBox!.getSize(new THREE.Vector3()).x).toBe(400);
      expect(geometry.boundingBox!.getSize(new THREE.Vector3()).z).toBe(400);
      geometry.dispose();
    });
  }
});

describe('actor endpoint alignment', () => {
  function context() {
    let tick: (dt: number, elapsed: number) => void = () => {};
    const { compiled, controller } = setup();
    const ctx: ActorContext = {
      scene: new THREE.Scene(), compiled, world: controller.events,
      follow: () => {},
      register: update => { tick = update; return () => {}; },
    };
    return { ctx, advance: () => tick(10, 10000) };
  }
  it('places a finished ghost at the exact witness endpoint', () => {
    const { ctx, advance } = context();
    const move = step(ctx.compiled, initialState(ctx.compiled), 'N')!;
    const ghost = new GhostActor(ctx, [move], 'replay', [], { onTick: () => {}, onArrive: () => {}, onFinish: () => {} });
    ghost.play();
    advance();
    expect(ghost.mesh.position.z).toBe(move.segments.at(-1)!.z);
    expect(ghost.mesh.position.y).toBe(move.segments.at(-1)!.y + 80);
    ghost.dispose();
  });
  it('places a player at the exact destination before reporting arrival', () => {
    const { ctx, advance } = context();
    const move = step(ctx.compiled, initialState(ctx.compiled), 'N')!;
    const player = new PlayerActor(ctx, { onState: () => {} });
    player.move('N');
    advance();
    expect(player.mesh.position.z).toBe(move.segments.at(-1)!.z);
    expect(player.mesh.position.y).toBe(move.segments.at(-1)!.y + 80);
    player.dispose();
  });

  it('reports a passThrough violation for a manual bypass route', () => {
    const level = {
      modules: [
        { id: 'spawn-pad', template: 'flat' as const, x: 5, z: 8, h: 0, ports: ['N', 'E'] as Cardinal[] },
        { id: 'mid', template: 'flat' as const, x: 5, z: 7, h: 0, ports: ['N', 'S', 'E'] as Cardinal[] },
        { id: 'goal-pad', template: 'flat' as const, x: 5, z: 6, h: 0, ports: ['S', 'E'] as Cardinal[] },
        { id: 'bypass-lane', template: 'flat' as const, x: 6, z: 8, h: 0, ports: ['W', 'N'] as Cardinal[] },
        { id: 'bypass-join', template: 'flat' as const, x: 6, z: 7, h: 0, ports: ['N', 'S', 'W'] as Cardinal[] },
        { id: 'bypass-end', template: 'flat' as const, x: 6, z: 6, h: 0, ports: ['S', 'W'] as Cardinal[] },
      ],
      keys: [],
      switches: [],
      spawn: 'spawn-pad',
      goal: 'goal-pad',
      doors: [],
      requirements: [{ type: 'passThrough' as const, moduleId: 'mid' }],
    };
    const compiled = compileLevel(level);
    const scene = new THREE.Scene();
    const world: WorldEvents = {
      updateState: () => {},
      collectKey: () => {},
      activateSwitch: () => {},
      resetWorld: () => {},
    };
    let tick: (dt: number, elapsed: number) => void = () => {};
    let state: { at: string; goalViolated: boolean } | null = null;
    const ctx: ActorContext = {
      scene,
      compiled,
      world,
      follow: () => {},
      register: update => {
        tick = update;
        return () => {};
      },
    };
    const player = new PlayerActor(ctx, { onState: info => { state = { at: info.at, goalViolated: info.goalViolated }; } });
    for (const action of ['E', 'N', 'N', 'W'] as Cardinal[]) {
      player.move(action);
      tick(10, 10000);
    }
    expect(state).toEqual({ at: 'goal-pad', goalViolated: true });
    player.dispose();
  });
});
