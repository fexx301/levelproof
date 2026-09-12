import type { GhostActor, PlayerActor } from './actors.js';

/**
 * Minimal imperative bridge between React panels and live scene actors.
 * Actors are created and disposed by the Viewport effects; panels reach
 * them through here for controls (restart / pause / step / move). The
 * bridge holds null whenever no actor is mounted — a stale actor is never
 * reachable.
 */
let ghost: GhostActor | null = null;
let player: PlayerActor | null = null;

export const actorBridge = {
  setGhost(actor: GhostActor | null): void {
    ghost = actor;
  },
  ghost(): GhostActor | null {
    return ghost;
  },
  setPlayer(actor: PlayerActor | null): void {
    player = actor;
  },
  player(): PlayerActor | null {
    return player;
  },
};
