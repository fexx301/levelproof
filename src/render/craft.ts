import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LevelModule } from '../../shared/schema.js';
import { GEOMETRY, centerPoint } from '../core/catalog.js';

/** Small manufactured edges, without changing catalog collision bounds. */
export function craftedBox(x: number, y: number, z: number, radius = 4): THREE.BufferGeometry {
  return new RoundedBoxGeometry(x, y, z, 2, Math.min(radius, x / 4, y / 4, z / 4));
}

/** A ramp's top follows the catalog exactly, in every orientation. */
export function rampGeometry(m: LevelModule): THREE.BufferGeometry {
  const rise = GEOMETRY.floorSpacingCm / GEOMETRY.cellPitchCm;
  const geometry = new THREE.BoxGeometry(GEOMETRY.cellPitchCm, GEOMETRY.floorSlabThicknessCm, GEOMETRY.cellPitchCm);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const along = m.orientation === 'N' ? -z : m.orientation === 'S' ? z : m.orientation === 'E' ? x : -x;
    position.setY(i, position.getY(i) - GEOMETRY.floorSlabThicknessCm / 2 + along * rise);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export function sceneBounds(modules: LevelModule[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  const half = GEOMETRY.cellPitchCm / 2 + 24;
  for (const module of modules) {
    const c = centerPoint(module);
    const rise = module.template === 'ramp' ? GEOMETRY.floorSpacingCm / 2 : 0;
    bounds.expandByPoint(new THREE.Vector3(c.x - half, c.y - rise - 30, c.z - half));
    // Shutters retract into their header; no leaf floats above the frame.
    bounds.expandByPoint(new THREE.Vector3(c.x + half, c.y + rise + 280, c.z + half));
  }
  return bounds;
}

export function framingPoints(modules: LevelModule[]): THREE.Vector3[] {
  return modules.flatMap(module => {
    const c = centerPoint(module);
    const half = GEOMETRY.cellPitchCm / 2 + 24;
    return [-half, half].flatMap(x => [-half, half].flatMap(z => [
      new THREE.Vector3(c.x + x, -124, c.z + z),
      new THREE.Vector3(c.x + x, c.y + 280, c.z + z),
    ]));
  });
}

/** Measure the home pose without disturbing the user's current orbit. */
export function fitOverview(camera: THREE.PerspectiveCamera, target: THREE.Vector3, direction: THREE.Vector3, points: THREE.Vector3[]): number {
  const savedPosition = camera.position.clone();
  const savedRotation = camera.quaternion.clone();
  let low = 400, high = 60000;
  for (let i = 0; i < 24; i++) {
    const distance = (low + high) / 2;
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const visible = points.every(point => {
      const p = point.clone().project(camera);
      return p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 0.87 && Math.abs(p.y) <= 0.87;
    });
    if (visible) high = distance;
    else low = distance;
  }
  camera.position.copy(savedPosition);
  camera.quaternion.copy(savedRotation);
  camera.updateMatrixWorld();
  return high;
}
