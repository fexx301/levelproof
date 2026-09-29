import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static world geometry merged by material (§12 performance). Floors, walls,
 * rails, piers, and foundations never move, yet each was its own draw call —
 * and most cast shadows, so twice over: a 72-room world drew ~800 calls a
 * frame. Merged, every material is one call. Picking still names the entity
 * hit: each entity keeps an invisible pick mesh with its exact shape (never
 * drawn, never in the shadow pass), and the merged meshes are left out of
 * raycasts. Rendering only — the engine never reads meshes.
 */

/** A parent-space, non-indexed copy with exactly position, normal, and uv. */
function bakedCopy(mesh: THREE.Mesh, toParent: THREE.Matrix4): THREE.BufferGeometry {
  const source = mesh.geometry.index !== null ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  source.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toParent, mesh.matrixWorld));
  if (source.getAttribute('normal') === undefined) source.computeVertexNormals();
  const count = source.getAttribute('position').count;
  const baked = new THREE.BufferGeometry();
  baked.setAttribute('position', source.getAttribute('position'));
  baked.setAttribute('normal', source.getAttribute('normal'));
  baked.setAttribute('uv', source.getAttribute('uv') ?? new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  return baked;
}

interface Bucket {
  geometries: THREE.BufferGeometry[];
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface MergeResult {
  /** Meshes folded into merged draws (0 when nothing was merged). */
  merged: number;
  /** Merged draw meshes added in their place. */
  draws: number;
}

/**
 * Merge every plain mesh under `roots` (children of `parent`) into one mesh
 * per material, added to `parent`. With `entityOf`, each entity also gets an
 * invisible pick mesh, registered through `tag`. All or nothing: if any
 * geometry cannot be merged, the scene is left exactly as it was.
 */
export function mergeStatic(
  parent: THREE.Object3D,
  roots: THREE.Object3D[],
  entityOf?: Map<THREE.Object3D, string>,
  tag?: (root: THREE.Object3D, id: string) => void,
): MergeResult {
  parent.updateMatrixWorld(true);
  const toParent = parent.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, Bucket>();
  const byEntity = new Map<string, THREE.BufferGeometry[]>();
  const mergedRoots: THREE.Object3D[] = [];
  let meshes = 0;

  for (const root of roots) {
    const found: THREE.Mesh[] = [];
    let mergeable = true;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object instanceof THREE.InstancedMesh || object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) mergeable = false;
      else found.push(object);
    });
    if (!mergeable || found.length === 0) continue;
    for (const mesh of found) {
      const baked = bakedCopy(mesh, toParent);
      const material = mesh.material as THREE.Material;
      const bucket = buckets.get(material) ?? { geometries: [], castShadow: false, receiveShadow: false };
      bucket.geometries.push(baked);
      bucket.castShadow ||= mesh.castShadow;
      bucket.receiveShadow ||= mesh.receiveShadow;
      buckets.set(material, bucket);
      const entity = entityOf?.get(mesh);
      if (entity !== undefined) byEntity.set(entity, [...(byEntity.get(entity) ?? []), baked]);
      meshes += 1;
    }
    mergedRoots.push(root);
  }
  if (meshes === 0) return { merged: 0, draws: 0 };

  // Build everything first; only then change the scene.
  const draws: THREE.Mesh[] = [];
  for (const [material, bucket] of buckets) {
    const geometry = mergeGeometries(bucket.geometries, false);
    if (geometry === null) {
      for (const draw of draws) draw.geometry.dispose();
      return { merged: 0, draws: 0 };
    }
    const draw = new THREE.Mesh(geometry, material);
    draw.castShadow = bucket.castShadow;
    draw.receiveShadow = bucket.receiveShadow;
    draw.userData.merged = true;
    // Picks resolve through the entity pick meshes, never the merged draw.
    draw.raycast = () => {};
    draws.push(draw);
  }
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const picks: Array<[THREE.Mesh, string]> = [];
  for (const [entity, geometries] of byEntity) {
    const shape = mergeGeometries(
      geometries.map((geometry) => new THREE.BufferGeometry().setAttribute('position', geometry.getAttribute('position'))),
      false,
    );
    if (shape === null) continue;
    const pick = new THREE.Mesh(shape, hidden);
    pick.userData.pick = true;
    picks.push([pick, entity]);
  }

  for (const root of mergedRoots) {
    root.removeFromParent();
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
  for (const draw of draws) parent.add(draw);
  for (const [pick, entity] of picks) {
    parent.add(pick);
    tag?.(pick, entity);
  }
  return { merged: meshes, draws: draws.length };
}
