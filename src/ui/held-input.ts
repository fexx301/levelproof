import type { MoveIntent } from './relative-direction.js';

/**
 * The on-screen arrow currently held down (touch or mouse), so a run carries
 * on through landings exactly like a held keyboard key.
 */
let padHeld: MoveIntent | null = null;

export function setPadHeld(intent: MoveIntent | null): void {
  padHeld = intent;
}

export function heldPadIntent(): MoveIntent | null {
  return padHeld;
}
