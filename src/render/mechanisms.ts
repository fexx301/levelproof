import type * as THREE from 'three';
import { doorPassable, initialState, type GameState } from '../core/movement.js';
import type { CompiledLevel } from '../core/topology.js';

interface DoorVisual {
  group: THREE.Group;
  openY: number;
  closedY: number;
  targetOpen: boolean;
}

export interface WorldVisuals {
  keys: Map<string, THREE.Group>;
  switches: Map<string, { plate: THREE.Mesh; rim: THREE.Mesh }>;
  doors: Map<string, DoorVisual>;
}

/** One bounded update loop. Reset cancels transitions rather than leaving callbacks alive. */
export function createMechanisms(compiled: CompiledLevel, visuals: WorldVisuals, reduced: () => boolean) {
  let state = initialState(compiled);
  const collections = new Map<string, number>();
  const retract = (door: DoorVisual) => {
    if (!door.group.userData.retracts) return;
    const progress = (door.group.position.y - door.closedY) / Math.max(1, door.openY - door.closedY);
    door.group.scale.y = Math.max(0.025, 1 - progress);
  };
  const sync = (snap: boolean) => {
    for (const [id, door] of visuals.doors) {
      door.targetOpen = doorPassable(compiled, id, state);
      if (snap || reduced()) door.group.position.y = door.targetOpen ? door.openY : door.closedY;
      retract(door);
    }
    for (const [id, key] of visuals.keys) {
      const collected = (state.keyMask & (compiled.keyBit.get(id) ?? 0)) !== 0;
      if (collected && !key.userData.collected && !snap && !reduced()) collections.set(id, 0);
      key.userData.collected = collected;
      if (snap || !collected || reduced()) {
        collections.delete(id);
        key.visible = !collected;
        key.scale.setScalar(1.6);
        key.position.y = key.userData.baseY as number;
      }
    }
    for (const [id, pad] of visuals.switches) {
      const active = (state.switchMask & (compiled.switchBit.get(id) ?? 0)) !== 0;
      pad.plate.userData.targetY = (pad.plate.userData.restY as number) - (active ? 9 : 0);
      if (snap || reduced()) pad.plate.position.y = pad.plate.userData.targetY as number;
      (pad.rim.material as THREE.MeshStandardMaterial).emissiveIntensity = active ? 1.7 : 0.65;
    }
  };
  const events = {
    updateState(next: GameState) { state = next; sync(false); },
    // State, not event ordering, determines all visuals.
    collectKey() { /* handled by updateState */ },
    activateSwitch() { /* handled by updateState */ },
    resetWorld() { state = initialState(compiled); collections.clear(); sync(true); },
  };
  events.resetWorld();
  return {
    events,
    update(dt: number) {
      const instant = reduced();
      for (const door of visuals.doors.values()) {
        const target = door.targetOpen ? door.openY : door.closedY;
        const k = instant ? 1 : 1 - Math.exp(-dt * (door.targetOpen ? 8 : 13));
        door.group.position.y += (target - door.group.position.y) * k;
        if (Math.abs(target - door.group.position.y) < 0.1) door.group.position.y = target;
        retract(door);
      }
      for (const pad of visuals.switches.values()) {
        const target = pad.plate.userData.targetY as number;
        pad.plate.position.y += (target - pad.plate.position.y) * (instant ? 1 : 1 - Math.exp(-dt * 18));
      }
      for (const [id, elapsed] of collections) {
        const key = visuals.keys.get(id)!;
        const progress = instant ? 1 : Math.min(1, elapsed + dt / 0.28);
        collections.set(id, progress);
        key.position.y = (key.userData.baseY as number) + 32 * progress;
        key.scale.setScalar(1.6 * (1 - progress));
        if (progress === 1) { key.visible = false; collections.delete(id); }
      }
    },
  };
}
