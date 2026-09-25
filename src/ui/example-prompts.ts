/**
 * The canonical demo prompts (§16), graded live by scripts/chip-battery.ts.
 * The shared exact-match cache (§10.2) serves a prewarmed chip instantly;
 * changing a word voids its cache entry and returns it to live-model odds.
 * Keep them byte-identical everywhere they appear: the UI example chips, the
 * README, the prewarm script, and the video script.
 */
export const EXAMPLE_PROMPTS = {
  // Naming the exact edge matters: "the vault door" alone makes the model
  // deliberate over which edge is meant (measured 5-27 s vs ~4 s).
  baseline: 'Put the brass key on the key balcony, and add a vault door between the vault approach and the vault entry that requires it.',
  trap: 'Add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.',
  removeRamp: 'Remove the ramp.',
  /**
   * One-click variant for the UI chip when no key exists yet: baseline + trap
   * in a single compile, cache-verified against the empty vault on production
   * (Sep 12). The model encodes the keyed vault door as a door condition, so
   * no rule approval is needed — one click reaches the signature moment.
   */
  trapOneShot:
    'Put the brass key on the key balcony and add a vault door between the vault approach and the vault entry that requires it. Then add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.',
} as const;

/**
 * The universal twist suggestion (§12 "Suggest a twist"): the model proposes
 * one mechanic that fits the current scene; the engine then judges it — a
 * twist that breaks recovery is the product working, not failing (red
 * floors, witness, checked repair). Byte-identical to scripts/reliability.ts.
 */
export const TWIST_PROMPT =
  'Suggest a twist for this puzzle: add one interesting mechanic — a seal-switch trap, a keyed gate, or a new keyed route — that fits the existing scene. Implement it as a single patch.';

/**
 * From-scratch builds offered on the blank canvas. Each is a live compile
 * (cached after its first run) and deliberately exercises scenery plus a real
 * mechanic, so a first-time visitor sees the world match the words.
 */
export const BUILD_PROMPTS = [
  {
    label: 'Haunted forest keep',
    prompt: 'Build a haunted forest keep at night: a gatehouse, a courtyard, and a crumbling tower with the key at the top. The treasure room is locked behind a door that needs the key, and a dragon statue guards it.',
  },
  {
    label: 'Frozen observatory',
    prompt: 'Build a frozen observatory on a snowy peak at dusk: two balconies reached by ramps, a silver key on one and a gold key on the other, and a vault door that needs both keys.',
  },
  {
    label: 'Pirate cove',
    prompt: 'Build a pirate cove on the open sea: three small docks joined by bridges over the water, a torch that unlocks the captain\'s gate, and a treasure chest on the goal dock.',
  },
  {
    label: 'Lava temple',
    prompt: 'Build a lava temple at night: a basalt causeway over a lava moat, braziers along the path, a gem that unlocks the inner sanctum, and a pressure plate that seals the entrance behind the player.',
  },
] as const;

/** Scene-agnostic edits for any existing puzzle. */
export const MAKEOVER_PROMPT =
  'Make it a spooky forest at night: dead trees around it, lanterns along the path, and a dragon statue guarding the goal.';
export const WINTER_PROMPT =
  'Turn it into a snowy mountain pass at dusk: snowy pines around it, lanterns along the path, and ice crystals near the goal.';
