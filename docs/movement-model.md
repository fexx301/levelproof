# The movement model

LevelProof movement is discrete and deterministic. Nothing about legality is
ever decided by the renderer, floats, or the model — one implementation,
`step()` / `transitions()` in `src/core/movement.ts`, serves the player, the
ghost, the verifier, and the repair search.

## The kit

- A 16×16 grid, elevations 0–2. Integer centimeters: 400 cm cell pitch,
  300 cm floor spacing, 160 cm player, 25 cm radius.
- Three module templates: **flat** (one cell at elevation h), **ramp** (one
  cell joining its low end at h to the opposite high end at h+1; orientation
  names the direction of ascent; ports are exactly the two ends), and
  **bridge** (a narrow walkway; undeclared sides carry rails). Different
  elevations may stack in one cell — bridges can cross directly over lower
  corridors.
- **Ports** are the open sides (N/E/S/W). Two modules connect only where
  facing ports coincide at the same elevation. A closed side is a wall; an
  open side with no matching neighbor gets a rail (legal, impassable).
- Items sit on flat modules, at most one per module: **keys** (collected on
  arrival, never consumed or dropped) and **switches** (activate once, on
  arrival). Spawn and goal always exist; goal states are terminal.

## Doors

Doors are **edge objects** between two connected modules — never geometry.
Conditions may combine:

- `requiresKey` — one key must be held;
- `requiresKeys` — an array: **every** listed key must be held (AND);
- `requiresSwitch` — the switch must be active;
- `closesAfterSwitch` — the door starts open and becomes permanently
  impassable the moment that switch activates.

All conditions are judged against the pre-move state.

## State and movement

A state is `(moduleId, keyMask, switchMask, phase)` — bounded at 32,768
states. `phase` is the turn within the world's cycle and is always 0 in a
level without hazards (so those levels behave exactly as before; a golden
test records every fixture's engine output to prove it).

### Turn-based hazards

- Every move, and the **wait** action (offered only when the cycle is longer
  than one turn), is one turn: `phase' = (phase + 1) mod cycle`.
- A **timed gate** is a door condition `cycle { period ∈ {2,3,4,6},
  openTicks }`: open while `phase mod period < openTicks`, judged on the
  pre-move phase like every other condition.
- A **guard** walks its route (2–4 connected, distinct rooms, never the spawn
  or goal) back and forth, one room per turn: period `2 × (length − 1)`. Its
  position depends only on the phase, never on the player.
- **Capture**: ending a turn in the guard's room, or trading places with it.
  The move's result is the initial state (the level restarts) and the move
  records `caught`.
- The **cycle** is the least common multiple of all gate and guard periods
  (at most 12); validation rejects a level whose worst case — rooms × key
  sets × switch sets × cycle — exceeds 32,768, so the check stays exhaustive.
- **Recovery ignores capture edges**: a restart is never a way out. A state
  from which every action gets the player caught is reported as *cornered*.
  Hints search for a capture-free route first.
One move: validate adjacency and door conditions against the pre-move
state, cross, arrive, collect a key or activate a switch, then recognize
the goal. Moves are catalog-owned polylines (center → shared port →
center); the renderer interpolates along them, but the floats never decide
legality. Measured: the golden fixture verifies in ~1 ms; a maximal
256-module layout at the state bound (32,320 states) verifies in ~140 ms
on the main thread.

## Why one engine matters

Because the player, the ghost, the verifier, and the repair search all call
the same `step()`, a witnessed failure is *provable*: every witness replays
through the real engine from the real initial state, or the result is an
internal error that blocks acceptance. The ghost you watch walk into a trap
is walking the exact route the checker found — not a visualization of a
guess.
