import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * The playable character: "Characters Matt" by Quaternius (CC0), an animated
 * low-poly adventurer (see public/models/LICENSE.md). One download is shared
 * by every actor; each actor gets its own skinned clone and animation mixer.
 * Rendering only — the engine's movement never depends on the model.
 */

const CHARACTER_URL = '/models/adventurer.glb';
/** Visual height: a little under the catalog's 160 cm player, so doors frame it. */
export const CHARACTER_HEIGHT_CM = 150;
/** Ground speed of the Run clip at timeScale 1, in model units per second
 * (foot travel per stance, measured from the clip). */
const RUN_UNITS_PER_SECOND = 1.84;
/** Below this ground speed the character is standing. */
const MOVING_CM_S = 20;
/** How long the character must stand still before settling into idle. */
const STOP_GRACE_S = 0.14;

export type CharacterClip = 'Idle' | 'Run' | 'Walk' | 'Jump' | 'Wave' | 'Yes' | 'No';

export interface CharacterAsset {
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  scale: number;
  floorOffset: number;
}

let assetPromise: Promise<CharacterAsset> | null = null;
let loadedAsset: CharacterAsset | null = null;

/** Start (or reuse) the one download; resolves to the prepared asset. */
export function preloadCharacter(): Promise<CharacterAsset> {
  if (assetPromise !== null) return assetPromise;
  assetPromise = new GLTFLoader().loadAsync(CHARACTER_URL).then((gltf) => {
    const scene = gltf.scene;
    // The source model carries a knife; a puzzle explorer does not.
    scene.getObjectByName('Knife')?.removeFromParent();
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const height = Math.max(box.max.y - box.min.y, 0.001);
    const clips = new Map<string, THREE.AnimationClip>();
    for (const clip of gltf.animations) clips.set(clip.name.split('|').at(-1) ?? clip.name, clip);
    loadedAsset = { scene, clips, scale: CHARACTER_HEIGHT_CM / height, floorOffset: -box.min.y };
    return loadedAsset;
  });
  assetPromise.catch(() => {
    // A failed download leaves the procedural fallback in place; allow a retry later.
    assetPromise = null;
  });
  return assetPromise;
}

/** The asset if it has already loaded (actors then build synchronously). */
export function characterIfLoaded(): CharacterAsset | null {
  return loadedAsset;
}

export interface CharacterStyle {
  /** Translucent tint for replay ghosts; omitted for the player. */
  ghost?: { color: number; opacity: number };
  /** Called at each footfall of the run cycle (for footstep sounds). */
  onFootstep?: () => void;
}

/** Where the Run clip's feet touch down, as fractions of the cycle (measured). */
const RUN_FOOTFALLS = [0.175, 0.658];

/**
 * A view-angle rim (fresnel) so the silhouette reads against any floor,
 * light, or effect: strong and tinted for ghosts, a faint edge light for the
 * player. `solid` also makes the rim opaque on a translucent material.
 */
function addRim(material: THREE.MeshStandardMaterial, color: number, strength: number, solid: boolean): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new THREE.Color(color) };
    shader.uniforms.rimStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;')
      .replace(
        '#include <opaque_fragment>',
        [
          'float rimFactor = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.2);',
          'outgoingLight += rimColor * rimFactor * rimStrength;',
          solid ? 'diffuseColor.a = max(diffuseColor.a, rimFactor);' : '',
          '#include <opaque_fragment>',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => `character-rim-${solid ? 'solid' : 'soft'}`;
}

/**
 * One animated character. `object` has its origin at the feet; callers
 * position and rotate it. `setLocomotion` drives idle/run from ground speed,
 * and `perform` plays a one-shot gesture before returning to locomotion.
 */
export class CharacterRig {
  readonly object = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly materials: THREE.Material[] = [];
  private readonly runTimeScale: number;
  private base: CharacterClip = 'Idle';
  private speed = 0;
  private stoppedFor = 0;
  private runPhase = 0;
  private readonly onFootstep: (() => void) | undefined;
  private current: THREE.AnimationAction | null = null;
  private gesture: { action: THREE.AnimationAction; then: CharacterClip | null } | null = null;

  constructor(asset: CharacterAsset, style: CharacterStyle = {}) {
    const model = cloneSkinned(asset.scene);
    model.scale.setScalar(asset.scale);
    model.position.y = asset.floorOffset * asset.scale;
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = style.ghost === undefined;
      child.receiveShadow = style.ghost === undefined;
      child.frustumCulled = false;
      const source = Array.isArray(child.material) ? child.material : [child.material];
      const cloned = source.map((material) => {
        const copy = material.clone() as THREE.MeshStandardMaterial;
        if (style.ghost !== undefined) {
          copy.transparent = true;
          copy.opacity = style.ghost.opacity;
          // Writing depth keeps the far arm and leg from showing through
          // the body; the ghost still blends over the scene behind it.
          copy.depthWrite = true;
          copy.emissive = new THREE.Color(style.ghost.color);
          copy.emissiveIntensity = 0.45;
          copy.color.lerp(new THREE.Color(style.ghost.color), 0.5);
          addRim(copy, new THREE.Color(style.ghost.color).lerp(new THREE.Color(0xffffff), 0.55).getHex(), 2.2, true);
        } else {
          addRim(copy, 0xfff1d6, 0.28, false);
        }
        this.materials.push(copy);
        return copy;
      });
      child.material = Array.isArray(child.material) ? cloned : cloned[0]!;
    });
    this.object.add(model);
    this.onFootstep = style.onFootstep;
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of asset.clips) this.actions.set(name, this.mixer.clipAction(clip));
    // Match the run cycle to the actor's ground speed so feet do not slide.
    this.runTimeScale = 1 / (RUN_UNITS_PER_SECOND * asset.scale);
    this.mixer.addEventListener('finished', (event) => {
      if (this.gesture === null || event.action !== this.gesture.action) return;
      const then = this.gesture.then;
      this.gesture = null;
      this.fadeTo(then ?? this.base, 0.25);
    });
    this.fadeTo('Idle', 0);
  }

  /** Ground speed in cm/s decides idle or run (a gesture finishes first).
   * Starting to run is immediate; stopping waits a moment so chained moves
   * keep one continuous run cycle instead of dipping into idle between them. */
  setLocomotion(speedCmPerSecond: number): void {
    this.speed = speedCmPerSecond;
    const run = this.actions.get('Run');
    if (run !== undefined && speedCmPerSecond > MOVING_CM_S) {
      run.timeScale = Math.max(0.6, Math.min(1.8, speedCmPerSecond * this.runTimeScale));
    }
    if (speedCmPerSecond > MOVING_CM_S) {
      this.stoppedFor = 0;
      this.setBase('Run');
    }
  }

  /** A one-shot gesture (cheer, head shake), then `then` loops (or locomotion). */
  perform(clip: CharacterClip, then: CharacterClip | null = null): void {
    const action = this.actions.get(clip);
    if (action === undefined) return;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = 1;
    this.gesture = { action, then };
    this.crossFade(action, 0.15);
  }

  /** Loop a gesture indefinitely (e.g. waving after a win). */
  loop(clip: CharacterClip): void {
    this.gesture = null;
    if (clip === 'Idle') {
      this.base = 'Idle';
      this.speed = 0;
    }
    this.fadeTo(clip, 0.25);
  }

  update(dt: number): void {
    if (this.speed <= MOVING_CM_S && this.base === 'Run') {
      this.stoppedFor += dt;
      if (this.stoppedFor >= STOP_GRACE_S || dt === 0) this.setBase('Idle');
    }
    this.mixer.update(dt);
    this.footfalls();
  }

  private footfalls(): void {
    const run = this.actions.get('Run');
    if (this.onFootstep === undefined || run === undefined) return;
    const duration = run.getClip().duration;
    const phase = duration > 0 ? (run.time % duration) / duration : 0;
    const audible = this.base === 'Run' && this.gesture === null && run.getEffectiveWeight() > 0.5;
    if (audible) {
      for (const at of RUN_FOOTFALLS) {
        const crossed = this.runPhase <= phase ? this.runPhase < at && at <= phase : this.runPhase < at || at <= phase;
        if (crossed) this.onFootstep();
      }
    }
    this.runPhase = phase;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    for (const material of this.materials) material.dispose();
    // Geometry is shared with the cached asset and must not be disposed here.
  }

  private setBase(next: CharacterClip): void {
    if (next === this.base) {
      // Setting off again mid-gesture: the run takes over.
      if (next === 'Run' && this.gesture !== null) {
        this.gesture = null;
        this.fadeTo('Run', 0.12);
      }
      return;
    }
    this.base = next;
    // Running interrupts a gesture; coming to rest lets it finish.
    if (this.gesture === null || next === 'Run') {
      this.gesture = null;
      this.fadeTo(next, next === 'Run' ? 0.12 : 0.25);
    }
  }

  private fadeTo(clip: CharacterClip, seconds: number): void {
    const action = this.actions.get(clip);
    if (action === undefined) return;
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    if (clip !== 'Run') action.timeScale = 1;
    this.crossFade(action, seconds);
  }

  private crossFade(action: THREE.AnimationAction, seconds: number): void {
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();
    if (this.current !== null && this.current !== action) {
      if (seconds > 0) this.current.crossFadeTo(action, seconds, false);
      else this.current.stop();
    }
    this.current = action;
  }
}
