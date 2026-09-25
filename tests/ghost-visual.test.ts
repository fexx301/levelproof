import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { compileLevel } from '../src/core/topology';
import { initialState, type GameState } from '../src/core/movement';
import { trapLevel } from '../src/core/fixtures/trap';
import { verify } from '../src/core/verifier';
import { GhostActor, type ActorContext, type WorldEvents } from '../src/render/actors';
import { buildGhostClothGeometry, createGhostVisual, GHOST_VISUAL_SIZE_CM, type GhostMotion } from '../src/render/ghost-visual';

function motion(overrides: Partial<GhostMotion> = {}): GhostMotion {
  return {
    velocity: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, 1),
    turning: 0,
    playing: true,
    finished: false,
    ...overrides,
  };
}

function positions(geometry: THREE.BufferGeometry): number[] {
  return Array.from(geometry.getAttribute('position').array as ArrayLike<number>);
}

function transform(object: THREE.Object3D) {
  return {
    position: object.position.toArray(),
    rotation: object.rotation.toArray(),
    scale: object.scale.toArray(),
  };
}

function visualSnapshot(object: THREE.Object3D) {
  const figure = object.getObjectByName('ghost-cloth-figure')!;
  const face = object.getObjectByName('ghost-face')!;
  const mouth = object.getObjectByName('ghost-mouth')!;
  const cloth = object.getObjectByName('ghost-cloth') as THREE.Mesh;
  const hem = object.getObjectByName('ghost-turned-under-hem') as THREE.Mesh;
  return {
    figure: transform(figure),
    face: transform(face),
    mouth: transform(mouth),
    eyes: Array.from(object.getObjectByName('ghost-face')!.children).filter(child => child instanceof THREE.Mesh && child !== mouth).map(transform),
    cloth: positions(cloth.geometry),
    hem: positions(hem.geometry),
  };
}

function preciseBounds(object: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3());
}

function maxDifference(left: number[], right: number[]): number {
  return left.reduce((max, value, index) => Math.max(max, Math.abs(value - (right[index] ?? 0))), 0);
}

describe('procedural cloth ghost visual', () => {
  it('blends the crown into the shoulders without an overhanging cap', () => {
    const geometry = buildGhostClothGeometry();
    const p = geometry.getAttribute('position');
    let previousRadius = 0;
    for (let ring = 0; ring < 11; ring++) {
      let radius = 0;
      for (let segment = 0; segment < 40; segment++) {
        const i = ring * 40 + segment;
        radius += Math.hypot(p.getX(i), p.getZ(i)) / 40;
      }
      expect(radius).toBeGreaterThan(previousRadius);
      previousRadius = radius;
    }
    geometry.dispose();
  });

  it('shears lower folds independently and keeps the face attached through a turn', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const rest = positions(visual.hem.geometry);
    for (let frame = 0; frame < 18; frame++) {
      visual.update(1 / 60, frame / 60, motion({
        velocity: new THREE.Vector3(240, 0, 180), turning: 0.8,
      }));
    }
    const moved = positions(visual.hem.geometry);
    // Opposite points must not merely receive a common translation.
    const differential = Math.hypot(
      (moved[0]! - rest[0]!) - (moved[60]! - rest[60]!),
      (moved[2]! - rest[2]!) - (moved[62]! - rest[62]!),
    );
    expect(differential).toBeGreaterThan(0.2);
    const face = visual.object.getObjectByName('ghost-face')!;
    expect(face.position.length()).toBeGreaterThan(0.1);
    visual.reset();
    expect(face.position.toArray()).toEqual([0, 0, 0]);
    expect(positions(visual.hem.geometry)).toEqual(rest);
    visual.dispose();
  });

  it('builds a finite, compact rounded cloth with a flared scalloped hem', () => {
    const geometry = buildGhostClothGeometry();
    const position = geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(16 * 20);
    expect(Array.from(position.array as ArrayLike<number>).every(Number.isFinite)).toBe(true);
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeLessThan(170);
    expect(size.z).toBeLessThan(170);
    expect(size.y).toBeGreaterThan(140);
    expect(geometry.boundingBox!.min.y).toBeGreaterThanOrEqual(-80);
    expect(GHOST_VISUAL_SIZE_CM.width).toBeLessThanOrEqual(120);
    expect(GHOST_VISUAL_SIZE_CM.depth).toBeLessThanOrEqual(120);
    geometry.dispose();
  });

  it('deforms from rest under velocity and returns exactly to rest on reset', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const before = positions(visual.cloth.geometry);
    visual.update(0.1, 100, motion({
      velocity: new THREE.Vector3(300, 0, -180),
      direction: new THREE.Vector3(1, 0, 0),
      turning: 0.6,
    }));
    expect(positions(visual.cloth.geometry)).not.toEqual(before);
    const bounds = new THREE.Box3().setFromObject(visual.object, true);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeLessThanOrEqual(120);
    expect(bounds.getSize(new THREE.Vector3()).z).toBeLessThanOrEqual(120);
    visual.reset();
    expect(positions(visual.cloth.geometry)).toEqual(before);
    visual.dispose();
  });

  it('freezes the complete pose when paused during a turn', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    visual.update(0.1, 100, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    visual.update(0.1, 200, motion({
      velocity: new THREE.Vector3(300, 0, 0),
      direction: new THREE.Vector3(1, 0, 0),
      turning: 0.8,
    }));
    const duringTurn = visualSnapshot(visual.object);
    visual.update(0, 300, motion({
      playing: false,
      velocity: new THREE.Vector3(-300, 0, 0),
      direction: new THREE.Vector3(-1, 0, 0),
      turning: -1,
    }));
    expect(visualSnapshot(visual.object)).toEqual(duringTurn);
    visual.update(0, 400, motion({ playing: false, direction: new THREE.Vector3(0, 0, -1) }));
    expect(visualSnapshot(visual.object)).toEqual(duringTurn);
    visual.dispose();
  });

  it('toggles reduced motion without changing facing or moving while paused', () => {
    let reduced = false;
    const visual = createGhostVisual({ reducedMotion: () => reduced });
    visual.update(0.1, 100, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    const animated = visualSnapshot(visual.object);
    const animatedFacing = (visual.object.getObjectByName('ghost-cloth-figure') as THREE.Group).rotation.y;

    reduced = true;
    visual.update(0, 200, motion({
      playing: false,
      velocity: new THREE.Vector3(300, 0, 0),
      direction: new THREE.Vector3(-1, 0, 0),
      turning: -1,
    }));
    const staticPose = visualSnapshot(visual.object);
    const staticFigure = visual.object.getObjectByName('ghost-cloth-figure') as THREE.Group;
    expect(staticFigure.rotation.y).toBeCloseTo(animatedFacing);
    expect(staticFigure.rotation.x).toBe(0);
    expect(staticFigure.rotation.z).toBe(0);
    expect(staticFigure.scale.x).toBe(animated.figure.scale[0]);
    expect(staticFigure.scale.z).toBe(animated.figure.scale[2]);
    expect(staticPose.cloth).not.toEqual(animated.cloth);

    reduced = false;
    visual.update(0, 300, motion({ playing: false, direction: new THREE.Vector3(0, 0, -1) }));
    expect(visualSnapshot(visual.object)).toEqual(staticPose);
    visual.update(0.1, 400, motion({
      velocity: new THREE.Vector3(0, 0, -300),
      direction: new THREE.Vector3(0, 0, -1),
    }));
    expect(visualSnapshot(visual.object)).not.toEqual(staticPose);
    visual.dispose();
  });

  it('keeps the body and turned-under hem welded through deformation', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    visual.update(0.1, 100, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    const body = positions(visual.cloth.geometry);
    const hem = positions(visual.hem.geometry);
    const bodyLastRing = body.length - (40 + 1) * 3;
    for (let i = 0; i < 40 * 3; i++) {
      expect(hem[i]).toBe(body[bodyLastRing + i]);
    }
    visual.dispose();
  });

  it('lets the skirt trail during travel and settle into a quieter idle pose', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const rest = positions(visual.hem.geometry);
    for (let frame = 0; frame < 24; frame++) {
      visual.update(1 / 60, frame / 60, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    }
    const travellingDifference = maxDifference(positions(visual.hem.geometry), rest);
    for (let frame = 0; frame < 90; frame++) {
      visual.update(1 / 60, (frame + 24) / 60, motion());
    }
    const idleDifference = maxDifference(positions(visual.hem.geometry), rest);
    expect(travellingDifference).toBeGreaterThan(5);
    expect(idleDifference).toBeLessThan(travellingDifference);
    visual.dispose();
  });

  it('settles to the authored folds instead of waving forever at idle', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const clothRest = positions(visual.cloth.geometry);
    const hemRest = positions(visual.hem.geometry);
    for (let frame = 0; frame < 24; frame++) {
      visual.update(1 / 60, frame / 60, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    }
    for (let frame = 0; frame < 180; frame++) {
      visual.update(1 / 60, (frame + 24) / 60, motion());
    }
    expect(maxDifference(positions(visual.cloth.geometry), clothRest)).toBeLessThan(0.25);
    expect(maxDifference(positions(visual.hem.geometry), hemRest)).toBeLessThan(0.25);
    const settled = visualSnapshot(visual.object);
    for (let frame = 0; frame < 60; frame++) visual.update(1 / 60, frame / 60, motion());
    expect(visualSnapshot(visual.object)).toEqual(settled);
    visual.dispose();
  });

  it('eases interrupted reactions and lets the finish pose settle without a snap', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    visual.update(0.1, 100, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    const beforeKey = visualSnapshot(visual.object);
    visual.trigger('key');
    expect(visualSnapshot(visual.object)).toEqual(beforeKey);
    visual.update(1 / 60, 116, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    const earlyKey = visualSnapshot(visual.object);
    for (let frame = 0; frame < 10; frame++) {
      visual.update(1 / 60, (frame + 2) * 16, motion({ velocity: new THREE.Vector3(0, 0, 300) }));
    }
    const peakKey = visualSnapshot(visual.object);
    expect(peakKey.face.scale[0]).toBeGreaterThan(earlyKey.face.scale[0]);

    const beforeFinish = visualSnapshot(visual.object);
    visual.trigger({ type: 'finish', kind: 'solution' });
    expect(visualSnapshot(visual.object)).toEqual(beforeFinish);
    visual.update(1 / 60, 300, motion({ playing: true, finished: true }));
    const earlyFinish = visualSnapshot(visual.object);
    expect(earlyFinish.figure.position[1]).toBeGreaterThanOrEqual(beforeFinish.figure.position[1]);
    for (let frame = 0; frame < 90; frame++) {
      visual.update(1 / 60, (frame + 20) / 60, motion({ playing: true, finished: true }));
    }
    const settledFinish = visualSnapshot(visual.object);
    expect(settledFinish.face.scale[1]).toBeGreaterThan(1);
    expect(settledFinish.figure.position[1]).toBeGreaterThan(0);
    const pausedFinish = visualSnapshot(visual.object);
    visual.update(0, 999, motion({ playing: false, finished: true, velocity: new THREE.Vector3(300, 0, -300) }));
    expect(visualSnapshot(visual.object)).toEqual(pausedFinish);
    visual.dispose();
  });

  it('keeps transformed bounds finite and inside the envelope for headings and turns', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const headings = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(1, 0, 1).normalize(),
    ];
    for (const direction of headings) {
      visual.reset();
      visual.setDirection(direction);
      for (let frame = 0; frame < 24; frame++) {
        visual.update(1 / 60, frame / 60, motion({
          velocity: direction.clone().multiplyScalar(300),
          direction,
          turning: Math.sin(frame * 0.4) * 0.8,
        }));
        const size = preciseBounds(visual.object);
        expect(size.x).toBeLessThanOrEqual(120);
        expect(size.z).toBeLessThanOrEqual(120);
        expect(new THREE.Box3().setFromObject(visual.object, true).min.y).toBeGreaterThanOrEqual(-80);
        expect(positions(visual.cloth.geometry).every(Number.isFinite)).toBe(true);
        expect(positions(visual.hem.geometry).every(Number.isFinite)).toBe(true);
      }
    }
    visual.dispose();
  });

  it('keeps the envelope during finish settling at every tested heading', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const headings = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
    ];
    for (const direction of headings) {
      visual.reset();
      visual.setDirection(direction);
      for (let frame = 0; frame < 18; frame++) {
        visual.update(1 / 60, frame / 60, motion({
          velocity: direction.clone().multiplyScalar(300),
          direction,
          turning: frame % 2 === 0 ? 0.9 : -0.9,
        }));
      }
      visual.trigger({ type: 'finish', kind: 'dead_end' });
      for (let frame = 0; frame < 72; frame++) {
        visual.update(1 / 60, (frame + 18) / 60, motion({ playing: true, finished: true, direction }));
        const bounds = new THREE.Box3().setFromObject(visual.object, true);
        const size = bounds.getSize(new THREE.Vector3());
        expect(size.x).toBeLessThanOrEqual(120);
        expect(size.z).toBeLessThanOrEqual(120);
        expect(bounds.min.y).toBeGreaterThanOrEqual(-80);
      }
    }
    visual.dispose();
  });

  it('produces nearly the same pose at 60Hz and 30Hz', () => {
    const sixty = createGhostVisual({ reducedMotion: () => false });
    const thirty = createGhostVisual({ reducedMotion: () => false });
    const direction = new THREE.Vector3(1, 0, 0);
    for (let frame = 0; frame < 30; frame++) {
      sixty.update(1 / 60, frame / 60, motion({
        velocity: direction.clone().multiplyScalar(300),
        direction,
        turning: 0.5,
      }));
    }
    for (let frame = 0; frame < 15; frame++) {
      thirty.update(1 / 30, frame / 30, motion({
        velocity: direction.clone().multiplyScalar(300),
        direction,
        turning: 0.5,
      }));
    }
    const sixtySnapshot = visualSnapshot(sixty.object);
    const thirtySnapshot = visualSnapshot(thirty.object);
    expect(Math.abs(sixtySnapshot.figure.rotation[0] - thirtySnapshot.figure.rotation[0])).toBeLessThan(0.01);
    expect(Math.abs(sixtySnapshot.figure.rotation[2] - thirtySnapshot.figure.rotation[2])).toBeLessThan(0.01);
    expect(maxDifference(sixtySnapshot.cloth, thirtySnapshot.cloth)).toBeLessThan(0.1);
    expect(maxDifference(sixtySnapshot.hem, thirtySnapshot.hem)).toBeLessThan(0.1);
    sixty.dispose();
    thirty.dispose();
  });

  it('bounds a long frame and does not accumulate cloth offsets', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const rest = positions(visual.cloth.geometry);
    visual.update(10, 10000, motion({ velocity: new THREE.Vector3(5000, 0, -5000), direction: new THREE.Vector3(1, 0, 0), turning: 1 }));
    expect(positions(visual.cloth.geometry).every(Number.isFinite)).toBe(true);
    for (let frame = 0; frame < 240; frame++) {
      visual.update(1 / 60, frame / 60, motion({ velocity: new THREE.Vector3(300, 0, 0), direction: new THREE.Vector3(1, 0, 0) }));
    }
    expect(maxDifference(positions(visual.cloth.geometry), rest)).toBeLessThan(30);
    visual.dispose();
  });

  it('keeps the visual stable under reduced motion', () => {
    const visual = createGhostVisual({ reducedMotion: () => true });
    const before = positions(visual.cloth.geometry);
    const rotation = visual.object.rotation.clone();
    visual.trigger({ type: 'finish', kind: 'dead_end' });
    visual.update(1, 1000, motion({ velocity: new THREE.Vector3(300, 0, 0) }));
    expect(positions(visual.cloth.geometry)).toEqual(before);
    expect(visual.object.rotation.equals(rotation)).toBe(true);
    visual.dispose();
  });

  it('disposes all owned resources once even when disposed twice', () => {
    const visual = createGhostVisual({ reducedMotion: () => false });
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    visual.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        geometries.push(child.geometry);
        const owned = Array.isArray(child.material) ? child.material : [child.material];
        materials.push(...owned);
      }
    });
    const geometrySpies = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));
    const materialSpies = [...new Set(materials)].map((material) => vi.spyOn(material, 'dispose'));
    visual.dispose();
    visual.dispose();
    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of materialSpies) expect(spy).toHaveBeenCalledOnce();
  });
});

describe('ghost actor lifecycle', () => {
  function context() {
    const compiled = compileLevel(structuredClone(trapLevel));
    const solution = verify(trapLevel).checks.solution.witness!;
    let tick: (dt: number, elapsed: number) => void = () => {};
    const worldState: GameState[] = [];
    const worldCalls = { reset: 0, keys: [] as string[], switches: [] as string[] };
    const world: WorldEvents = {
      updateState: state => worldState.push(state),
      collectKey: id => { worldCalls.keys.push(id); },
      activateSwitch: id => { worldCalls.switches.push(id); },
      resetWorld: () => { worldCalls.reset++; },
    };
    const ctx: ActorContext = {
      scene: new THREE.Scene(),
      compiled,
      world,
      follow: () => {},
      register: update => {
        tick = update;
        return () => {};
      },
    };
    return { ctx, route: solution.route, worldCalls, worldState, advance: (dt: number) => tick(dt, dt * 1000) };
  }

  it('seeds facing from the first nonzero segment across the whole route', () => {
    const { ctx, route } = context();
    const firstPoint = route[0]!.segments[0]!;
    const delayedRoute = [
      { ...route[0]!, segments: route[0]!.segments.map(() => ({ ...firstPoint })) },
      ...route.slice(1),
    ];
    const expected = new THREE.Vector3(0, 0, 1);
    let found = false;
    for (const move of delayedRoute) {
      for (let i = 1; i < move.segments.length; i++) {
        expected.set(
          move.segments[i]!.x - move.segments[i - 1]!.x,
          0,
          move.segments[i]!.z - move.segments[i - 1]!.z,
        );
        if (expected.lengthSq() > 0.0001) {
          expected.normalize();
          found = true;
          break;
        }
      }
      if (found) break;
    }
    const ghost = new GhostActor(ctx, delayedRoute, 'solution', [], {
      onTick: () => {},
      onArrive: () => {},
      onFinish: () => {},
    });
    const figure = ghost.mesh.getObjectByName('ghost-cloth-figure')!;
    expect(figure.rotation.y).toBeCloseTo(Math.atan2(expected.x, expected.z));
    ghost.restart();
    expect(figure.rotation.y).toBeCloseTo(Math.atan2(expected.x, expected.z));
    ghost.dispose();
  });

  it('settles the terminal visual after the route finishes, then freezes it', () => {
    const { ctx, route, advance } = context();
    const onFinish = vi.fn();
    const ghost = new GhostActor(ctx, route, 'solution', [], {
      onTick: () => {},
      onArrive: () => {},
      onFinish,
    });
    ghost.play();
    advance(60);
    expect(onFinish).toHaveBeenCalledOnce();
    const atFinish = visualSnapshot(ghost.mesh);
    advance(1 / 60);
    expect(visualSnapshot(ghost.mesh)).not.toEqual(atFinish);
    for (let frame = 0; frame < 60; frame++) advance(1 / 60);
    const settled = visualSnapshot(ghost.mesh);
    advance(1 / 60);
    expect(visualSnapshot(ghost.mesh)).toEqual(settled);
    ghost.dispose();
  });

  it('replays the verifier solution, keeps pause frozen, and restart clears route history', () => {
    const { ctx, route, worldCalls, worldState, advance } = context();
    const onArrive = vi.fn();
    const onFinish = vi.fn();
    const ghost = new GhostActor(ctx, route, 'solution', [], {
      onTick: () => {},
      onArrive,
      onFinish,
    });
    const figure = ghost.mesh.getObjectByName('ghost-cloth-figure')!;
    expect(figure.rotation.y).toBeCloseTo(Math.PI);
    ghost.play();
    advance(0.2);
    const pausedAt = ghost.mesh.position.clone();
    const cloth = ghost.mesh.getObjectByName('ghost-cloth') as THREE.Mesh;
    const pausedCloth = positions(cloth.geometry);
    const pausedVisual = visualSnapshot(ghost.mesh);
    ghost.pause();
    advance(1);
    expect(ghost.mesh.position.toArray()).toEqual(pausedAt.toArray());
    expect(positions(cloth.geometry)).toEqual(pausedCloth);
    expect(visualSnapshot(ghost.mesh)).toEqual(pausedVisual);
    ghost.play();
    advance(60);
    expect(onArrive).toHaveBeenCalledTimes(route.length);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(worldCalls.keys).toEqual(route.flatMap(move => move.events.collectedKey ? [move.events.collectedKey] : []));
    expect(worldCalls.switches).toEqual(route.flatMap(move => move.events.activatedSwitch ? [move.events.activatedSwitch] : []));
    expect(worldState.at(-1)).toEqual(route.at(-1)!.after);

    ghost.restart();
    expect(ghost.mesh.position.toArray()).toEqual([
      route[0]!.segments[0]!.x,
      route[0]!.segments[0]!.y + 80,
      route[0]!.segments[0]!.z,
    ]);
    expect(worldCalls.reset).toBeGreaterThanOrEqual(2);
    expect(worldState.at(-1)).toEqual(initialState(ctx.compiled));
    expect(figure.rotation.y).toBeCloseTo(Math.PI);
    ghost.dispose();
    ghost.dispose();
  });

  it('pauses at the configured decisive move and resumes the same witness route', () => {
    const { ctx, route, advance } = context();
    const tick = vi.fn();
    const onFinish = vi.fn();
    const ghost = new GhostActor(ctx, route, 'solution', [], {
      onTick: tick,
      onArrive: () => {},
      onFinish,
    }, 1);

    ghost.play();
    advance(60);

    expect(tick).toHaveBeenLastCalledWith(expect.objectContaining({
      playing: false,
      finished: false,
      pausedAtEvidence: true,
      moveIndex: 1,
    }));
    expect(onFinish).not.toHaveBeenCalled();
    expect(ghost.mesh.position.toArray()).toEqual([
      route[0]!.segments.at(-1)!.x,
      route[0]!.segments.at(-1)!.y + 80,
      route[0]!.segments.at(-1)!.z,
    ]);

    ghost.play();
    advance(60);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(tick).toHaveBeenLastCalledWith(expect.objectContaining({ finished: true, pausedAtEvidence: false }));
    ghost.dispose();
  });
});
