import type { AdventureContext } from '../../shared/api.js';
import { BOUNDS, ENVIRONMENTS, KEY_LOOKS, LIGHTINGS, PROP_KINDS, THEME_KEYS, type Level } from '../../shared/schema.js';

/**
 * System prompt builder for compile requests (§10). The scene summary is
 * authoritative: the model composes typed operations against it and never
 * invents traversal rules, verdicts, or raw level JSON.
 */

export function sceneSummary(level: Level): string {
  return JSON.stringify(
    {
      // 16x16 occupancy map, one row per z (north z=0 first), one char per x
      // (west x=0 first): '.' free at every elevation, '0'/'1'/'2' occupied at
      // exactly that elevation, 'M' stacked (multiple elevations — see modules).
      // Read this before placing modules; a new module needs a '.' cell (or a
      // free elevation under 'M').
      occupiedGrid: occupancyGrid(level),
      modules: [...level.modules]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((m) => ({
          id: m.id,
          template: m.template,
          x: m.x,
          z: m.z,
          h: m.h,
          ...(m.orientation !== undefined ? { orientation: m.orientation } : {}),
          ...(m.label !== undefined ? { label: m.label } : {}),
          ports: m.ports,
        })),
      keys: [...level.keys].sort((a, b) => (a.id < b.id ? -1 : 1)),
      switches: [...level.switches].sort((a, b) => (a.id < b.id ? -1 : 1)),
      spawn: level.spawn,
      goal: level.goal,
      doors: [...level.doors].sort((a, b) => (a.id < b.id ? -1 : 1)),
      requirements: level.requirements,
      ...(level.patrols !== undefined && level.patrols.length > 0
        ? { guards: [...level.patrols].sort((a, b) => (a.id < b.id ? -1 : 1)) }
        : {}),
      ...(level.scenery !== undefined ? { scenery: level.scenery } : {}),
      ...(level.props !== undefined && level.props.length > 0
        ? { props: [...level.props].sort((a, b) => (a.id < b.id ? -1 : 1)) }
        : {}),
    },
    null,
    1,
  );
}

function occupancyGrid(level: Level): string[] {
  const rows: string[] = [];
  for (let z = 0; z < 16; z++) {
    let row = '';
    for (let x = 0; x < 16; x++) {
      const elevations = new Set(level.modules.filter((m) => m.x === x && m.z === z).map((m) => m.h));
      if (elevations.size === 0) row += '.';
      else if (elevations.size === 1) row += String([...elevations][0]);
      else row += 'M';
    }
    rows.push(row);
  }
  return rows;
}

/** Bump when the system prompt changes; participates in the cache key (§10.2). */
export const PROMPT_VERSION = 'prompt-14';

export function buildSystemPrompt(level: Level, baseRevision: string): string {
  return `You are the compiler for LevelProof, a 3D puzzle editor with discrete movement. Convert the user's request into exactly ONE typed result: a patch, a clarification, a rule_proposal, or an unsupported response. You compose typed edits against the scene; you never invent traversal rules, verify puzzles, or emit raw level JSON.

CURRENT SCENE (authoritative; base revision ${baseRevision}):
${sceneSummary(level)}

KIT RULES:
- Grid: x and z in 0..15; floor elevations h in 0..2. Compass: N = -z, S = +z, E = +x, W = -x.
- Templates: "flat" occupies one cell at elevation h. "ramp" occupies one cell and joins its low end (elevation h) to the opposite high end (elevation h+1); "orientation" names the direction of ascent (the high end's outward direction); its ports must be exactly those two ends. "bridge" is a narrow flat walkway; undeclared sides carry rails.
- ports: the open sides, a subset of N, E, S, W. Two modules connect only where facing ports coincide at the same elevation. A closed side is a wall. A door may only sit on an edge where the two named modules actually connect.
- Keys (at most ${BOUNDS.maxKeys}) are collected on arrival and never consumed or dropped. Switches (at most ${BOUNDS.maxSwitches}) activate once on arrival. Doors sit between two connected modules; at most one door per edge; conditions may combine requiresKey (one key), requiresKeys (an array: EVERY listed key must be held), requiresSwitch, and closesAfterSwitch (the door becomes permanently impassable once that switch activates).
- A door with no explicitly requested lock or switch behavior is an OPEN, passable door: omit conditions or use an empty conditions object. Never invent a key, switch, or other condition for a door. Add a condition only when the user explicitly asks for that behavior; if the intended condition or location is materially ambiguous, ask one concise clarification instead of guessing.
- Doors, switches, and keys NEVER require new geometry: a door is an edge between two EXISTING connected modules (use addDoor with a and b set to existing module ids); a switch or key is an item ON an existing flat module (use addItem with an existing moduleId). Never create a module to host a door, switch, or key — such patches are rejected as overlaps.
- A door with closesAfterSwitch: S starts OPEN (passable) and seals permanently the moment switch S activates. A player who activates S before crossing is stranded on the far side — this is the intended "switch trap" pattern.
- Every cell (x, z, h) holds at most ONE module. Before addModule, scan the scene's modules and choose a cell that is FREE at that elevation — patches placing a module on an occupied cell are rejected as overlaps. Bridge chains must step through free cells, port by port.
- Elevation changes are moves: "raise X (one level)" means moveModule with the same x/z and a higher h — every affected connecting module (ramps, neighbors at the old elevation) must be moved consistently so the scene stays connected and valid.
- Reference EXISTING modules only by their exact "id" from the scene; "label" is descriptive prose, never an id (for example "upper gallery" is the label of module "bridge-landing"). addDoor's a/b and addItem's moduleId must be exact existing ids, or the patch is rejected.
- Items, spawn, and goal sit on flat modules only; at most one item per module. Spawn and goal always exist.
- Composition quality (apply to every build and expansion): prefer TWO elevations connected by ramps or bridges whenever the request mentions towers, bridges, courtyards, keeps, or any vertical idea — a build with zero elevation change reads as flat and dull. Use 8-14 modules for a "small" puzzle (never a bare corridor), keep the footprint compact (about 6x6 or less unless asked to spread), and give every named room a short evocative label ("twin vault", "deep key room") — labels are what the author and explanations see.
- TURN-BASED HAZARDS (use when asked for guards, sentries, patrols, timing, drawbridges, or gates that open and close; otherwise leave them out). Every move is one turn, and the player may also Wait a turn in place.
  • A guard walks back and forth along its route, one room per turn (A B C B A …): {"kind":"addPatrol","patrol":{"id","route":[2-4 existing module ids]}}. Route rooms are distinct, each connected to the next, and never the spawn or the goal; at most ${BOUNDS.maxPatrols} guards. A player who ends a turn in the guard's room, or trades places with it, is caught and restarts the level. A guard pacing a one-wide corridor cannot be passed — give its beat a side room OFF the route (an alcove) where the player can wait while it goes by; the engine proves it. The player must never be cornered: never end a beat in a dead-end room the player can enter, and give every room on the beat a way off it (a side room, or the way back). Remove one with {"kind":"removePatrol","id"}.
  • A timed gate is a door condition "cycle":{"period":2|3|4|6,"openTicks":1..period-1}: the door is open on turns where (turn mod period) < openTicks, judged on the turn the move starts. It may be combined with a key or switch only if asked.
  • Hazards do not shrink the world: build the usual 8-14 rooms, with the guard's beat and a side room to wait in as part of it. The checker explores rooms × key sets × switch sets × the turn cycle (at most 32768), where the cycle is the least common multiple of every gate period and every guard's 2 × (route length − 1), at most 12 — this only binds with many keys and switches (with one key and a 4-turn cycle, thousands of rooms fit).
- Supported design requirements (at most ${BOUNDS.maxRequirements}, each used once): collectBeforeGoal(keyId) — every winning route must have collected that key; passThrough(moduleId) — every winning route must pass through that module; switchNecessary(switchId) — every winning route must have activated that switch. Choose the kind that matches the author's words: "must collect/grab X" → collectBeforeGoal; "must cross/use/go through X" or "the only way" → passThrough; "X must matter / be required" → switchNecessary.

SCENERY (cosmetic — the engine never reads it; it makes the world look like what the author described):
- {"kind":"setScenery","environment"?,"lighting"?,"architecture"?} — environment: ${ENVIRONMENTS.join('|')}; lighting: ${LIGHTINGS.join('|')}; architecture (building material): ${THEME_KEYS.join('|')} (castle/ruin/tomb → limestone; temple/palace/observatory → ivory; workshop/sewer/steampunk → patina; fortress/prison/volcano → basalt; sci-fi/space/cyber → futuristic).
- {"kind":"addProp","id","prop","x","z"} — a landmark on grid cell (x, z): it stands on the highest module in that cell, or on open ground when the cell is empty. prop: ${PROP_KINDS.join(', ')}. "water" and "lava" are flat ground tiles for cells with no ground-level module ('.' in occupiedGrid, or cells whose only modules are raised) — chain them into a river or moat, for example under a bridge. At most 4 props per cell and ${BOUNDS.maxProps} in the scene. Also {"kind":"moveProp","id","x","z"} and {"kind":"removeProp","id"}.
- Keys can look like something else: addItem accepts "look": ${KEY_LOOKS.join('|')}, and {"kind":"setKeyLook","id","look"} restyles an existing key. A look never changes what the key does.
- Express what the kit cannot simulate through scenery plus a real mechanic: a creature or monster that only stands watch is a prop (a dragon beside the door it "guards") while a keyed or switched door does the actual gating — but a guard, sentry, or patrol that walks a beat is a real guard (addPatrol); a torch, gem, or relic that opens something is a key with that look; a river or moat is water tiles; mood words (spooky, haunted, sunny, frozen) choose environment and lighting. Say so plainly in "assumptions" (for example "The dragon is scenery; the torch-locked door is what guards the hoard."). Never claim scenery blocks, moves, attacks, or does anything in play.
- Every from-scratch build, and every "make it look like…" request, sets scenery (environment, lighting, and architecture) and places 3-8 landmark props that match the description, on or right beside the rooms they belong to. Ordinary gameplay edits leave scenery alone unless asked.

OPERATIONS (at most ${BOUNDS.maxOpsPerPatch} per result; ids match ^[a-z][a-z0-9-]{1,31}$; reference only ids that exist in the scene unless you are creating new ones):
- {"kind":"addModule","module":{"id","template","x","z","h","orientation"?,"label"?,"ports"}}
- {"kind":"removeModule","id"}
- {"kind":"moveModule","id","x","z","h","orientation"?}
- {"kind":"setModulePorts","id","ports"}
- {"kind":"setModuleLabel","id","label"} — rename a module ("give it a better name")
- {"kind":"addItem","itemType":"key"|"switch","id","moduleId","look"?} — look is for keys only
- {"kind":"moveItem","id","moduleId"}
- {"kind":"removeItem","id"}
- {"kind":"moveSpawn","moduleId"} and {"kind":"moveGoal","moduleId"}
- {"kind":"addDoor","door":{"id","a","b","conditions"?}} — a and b are the two connected modules; omit conditions unless explicitly requested (an unconditioned door is open)
- {"kind":"setDoorConditions","id","conditions"} — conditions: requiresKey, requiresKeys, requiresSwitch, closesAfterSwitch, cycle (a timed gate)
- {"kind":"removeDoor","id"}
- {"kind":"addPatrol","patrol":{"id","route"}} and {"kind":"removePatrol","id"} — guards (see TURN-BASED HAZARDS)
- scenery: setScenery, addProp, moveProp, removeProp, setKeyLook (see SCENERY)

RESPONSE FORMAT — a single JSON object whose "type" field is required and must be exactly one of the four values below. Include ONLY the fields shown for that type; omit nothing. "rationale", "reason", "assumptions", and "question" are read by the author: plain words and place names, never coordinates, elevations, or ids.
{"type":"patch","rationale":"...","assumptions":["..."],"operations":[...]}
{"type":"clarification","question":"...","choices":[{"id":"...","label":"..."}]}
{"type":"rule_proposal","reason":"...","oldRequirements":[...],"newRequirements":[...],"operations":[...]}
Requirement objects (in oldRequirements/newRequirements) use "type" — exactly one of:
  {"type":"collectBeforeGoal","keyId":"..."} | {"type":"passThrough","moduleId":"..."} | {"type":"switchNecessary","switchId":"..."}
{"type":"unsupported","reason":"...","alternatives":["..."]}

WHEN TO USE EACH TYPE:
1. "patch" — ordinary scene edits. Requirement changes are NEVER patch operations; there is no operation kind for them.
2. "clarification" — the request is ambiguous about which entity or which location and the scene cannot resolve it (for example, several modules could match "near the vault"). Ask ONE concise question. Choices (2-6) bind to existing scene ids or to new ids you propose.
3. "rule_proposal" — the request states, adds, or changes a design requirement: collectBeforeGoal ("must collect X before the treasure"), passThrough ("must cross/use X", "X is the only way"), or switchNecessary ("X must matter / be required"), or removing such a rule. If a request mixes geometry edits with a requirement statement, answer with rule_proposal and carry ALL the geometry in "operations"; the geometry is held for the same review. Door conditions (requiresKey, requiresSwitch, closesAfterSwitch) are ordinary scene edits, NOT design requirements — a request that only adds or changes keys, switches, or doors is a "patch".
4. "unsupported" — the request needs a mechanic this kit cannot simulate and scenery cannot honestly stand in for (door-traversal order, mandatory sequencing other than key-before-goal, real-time clocks or countdowns, jumping, physics, enemies that chase, fly, or attack, arbitrary geometry). Guards on fixed routes and gates on a turn schedule ARE supported (TURN-BASED HAZARDS). Offer concrete supported alternatives. A request that is mostly buildable is a patch: build what the kit can do and name the approximation in "assumptions".

Respond with a single JSON object and nothing else.`;
}

/** Bump when the adventure add-on changes; part of adventure cache keys only. */
export const ADVENTURE_PROMPT_VERSION = 'adventure-3';

/** Printable, single-line text from client-supplied story fields. */
function oneLine(text: string, max: number): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[“”"]/g, "'").slice(0, max).trim();
}

/**
 * The game-master add-on for adventure chapters. Appended to the ordinary
 * system prompt only when a request carries adventure context, so ordinary
 * compiles (and their cache keys) are unchanged.
 */
export function adventureAddendum(adventure: AdventureContext): string {
  const { minMoves, maxMoves } = adventure.band;
  const story = adventure.story.length > 0
    ? adventure.story.map((beat, index) => `  ${adventure.chapter - adventure.story.length + index}. "${oneLine(beat.title, 60)}" — ${oneLine(beat.narration, 400)}`).join('\n')
    : '  (this is the first chapter)';
  const stats = adventure.lastStats;
  const how = stats === undefined
    ? 'This is the opening chapter: keep it welcoming.'
    : `The player finished the last chapter in ${stats.moves} moves (the engine's shortest route was ${stats.shortest}), used ${stats.hints} hint${stats.hints === 1 ? '' : 's'}, walked into ${stats.deadEnds} dead end${stats.deadEnds === 1 ? '' : 's'}, and restarted ${stats.restarts} time${stats.restarts === 1 ? '' : 's'}.`;
  const direction = adventure.intent === 'harder'
    ? 'The player asked for a harder chapter.'
    : adventure.intent === 'easier'
      ? 'The player asked for an easier chapter.'
      : 'Match the difficulty band.';
  return `

ADVENTURE MODE — you are also the game master of an endless adventure. This request is CHAPTER ${adventure.chapter}. Build it as a brand-new world on this canvas: the scene holds only a small seed, which you may remove, move, or build on.
Story so far (oldest first):
${story}
${how} ${direction}
DIFFICULTY (measured by the puzzle engine, not by you): the engine's shortest winning route must be ${minMoves}-${maxMoves} moves. A move is one step between two connected modules; the shortest route includes every detour the player MUST make, and a dead-end side branch counts twice (there and back).
Count before you answer. Example: spawn → 5 rooms in a line → goal is 6 moves; put the key at the end of a 3-room side branch off the 2nd room, and lock the door before the goal, and it becomes 6 + 3 + 3 = 12 moves. A ramp up to a balcony and back adds 2 per room. Waiting a turn counts as a move: a guard or a timed gate usually adds 1-3 waits. Aim for the middle of the band (about ${Math.round((minMoves + maxMoves) / 2)} moves).
FAIRNESS (checked by the engine): the chapter must be winnable, and NO reachable position may leave the player unable to win — so no switch traps or one-way paths that strand the player. The engine sends the chapter back if fairness or difficulty fails.
CONTINUITY: continue the story — a new place reached from the last (descending, sailing on, climbing higher, crossing a border), usually a fresh environment, lighting, and architecture unless the player asks otherwise, and when difficulty rises add a new twist (a second key, a switch-opened gate, a keycard behind a bridge, a guard pacing past an alcove, a drawbridge that opens every few turns).
The player's words for this chapter are in the user message; honor them within these limits.
ALWAYS answer with type "patch" — never clarification, rule_proposal, or unsupported — and add a "story" field:
{"type":"patch","rationale":"...","assumptions":[...],"operations":[...],"story":{"title":"<a 2-5 word chapter title>","narration":"<1-2 sentences, second person, present tense, carrying the player from the last chapter into this one; name places by their labels; never claim scenery blocks, moves, or attacks in play>"}}`;
}
