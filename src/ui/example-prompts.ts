/**
 * The canonical demo prompts (§16). These exact strings are cache-verified
 * end-to-end on production (DECISIONS.md, Sep 12): the baseline accepts green
 * and the trap fails Recovery with the stranded witness. The exact-match
 * cache (§10.2) makes them deterministic and free; changing a word voids the
 * cache and returns the result to live-model odds. Keep them byte-identical
 * everywhere they appear: the UI example chips, the README, and the video
 * script.
 */
export const EXAMPLE_PROMPTS = {
  baseline: 'Put the brass key on the key balcony, and make the vault door require it.',
  trap: 'Add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.',
  removeRamp: 'Remove the ramp.',
  /**
   * One-click variant for the UI chip when no key exists yet: baseline + trap
   * in a single compile, cache-verified against the empty vault on production
   * (Sep 12). The model encodes the keyed vault door as a door condition, so
   * no rule approval is needed — one click reaches the signature moment.
   */
  trapOneShot:
    'Put the brass key on the key balcony and make the vault door require it. Then add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.',
} as const;
