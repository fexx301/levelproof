# DECISIONS

Build-window decisions and measured evidence, newest first. Dates are 2026.

## Sep 13 (strategic pass part 2 — conversation, themes)

- **Conversational editing shipped** (`7fac0b6`, `f29d241`): compile
  requests carry the last six turns (cache-keyed; the system prompt frames
  them as context — the scene already reflects applied edits), every
  applied patch shows a **one-line change summary** ("Changed: moved
  'goal-pad', ramp 'keep-ramp', flat 'gate-room' +3 more"), and a
  **revision history** (last 12 accepted checkpoints, labeled by prompt or
  repair) restores any prior level with one click. Follow-up battery
  (`ONLY=followup`, 5 two-turn conversations with anaphora, semantically
  graded): **4/5** — the miss asked a genuinely ambiguous question
  ("make it harder") and a clarification was a defensible answer.
- **Two conversation gaps found and closed**: there was **no
  setModuleLabel operation** (renames returned `unsupported` — the model
  was right), and elevation changes needed explicit guidance ("raise X"
  = moveModule with consistent reconnection). Both shipped; the failing
  battery cases now pass.
- **Theme promptability shipped** (`f23de4a`): presentation themes
  (limestone / ivory / patina / basalt) as a **side-channel** —
  word-detected from the prompt, sent on the request, echoed by the
  server, overriding the renderer's scene-derived default. No theme field
  enters the level schema or verifier (the art-direction module's own
  contract); the system prompt tells the model never to encode visual
  style in operations. Live-verified through the API (theme echo) and
  unit-verified in the renderer (all four themes resolve correctly after
  fixing a key-mapping bug the first live test caught).
- **Tooling note**: the long-lived headless browser session eventually
  degrades beyond single tabs (blank loads on fresh tabs that reload
  fine); production was re-verified healthy via three consecutive clean
  loads with error listeners attached before trusting any interactive
  test from it again.

## Sep 13 (strategic pass — judge-prompt reliability, extended requirements)

- **Judge-prompt reliability, measured honestly** (reviewer-advised
  upgrade): the scratch battery expanded to 16 judge-voice phrasings
  (courtyard with vault underneath, twin towers, island chains, zigzag
  descents, lighthouses…), and — after a blocker advisory correctly noted
  the old grader only checked "valid + green" — every fixture gained
  **per-prompt semantic assertions** (module/key/door/bridge/ramp counts,
  elevations present, keyed-gate relationships; e.g. "four islands" now
  requires ≥3 bridges and exactly 7 modules). **Result: 15/16 fresh
  (94%), with the single failure a provider-latency timeout, not a model
  error** — the same prompt passes on retry with a 13-op accepted build.
  Cost ~$0.23 per full battery run.
- **Latency root-caused**: deployed compiles for compound builds run
  15–32s wall while identical direct provider calls run 1.5–3s — the gap
  is serverless egress/provider routing variance, not model thinking.
  Mitigation: `LLM_TIMEOUT_MS` raised to 45000 (fits the 52s service
  deadline; per-attempt clamps unchanged). Residual variance accepted and
  recorded; chasing OpenRouter routing is out of scope. The UI's Compiling
  state and stale-discard guard keep slow compiles safe.
- **Extended verified requirements shipped** (§5, the moat-deepener):
  `passThrough(moduleId)` — every winning route must cross a module — and
  `switchNecessary(switchId)` — every winning route must activate a
  switch. Soundness design (reviewer-advised): goal states record
  `(module, keyMask, switchMask)`; because item collection is automatic
  and permanent, masks DO encode item-module visits — so collectBeforeGoal
  and switchNecessary (switches are one-shot monotonic) are sound on goal
  states. **passThrough is NOT** — plain modules leave no state trace and
  routes merge at shared states — so it is checked by a counterexample
  search (goal reachable while never arriving at the module), with the
  witness replay-verified to actually avoid the module. Tests pin the
  merging-route trap case explicitly. Wire schema, system prompt (with
  kind-selection guidance: "must cross" → passThrough, "must matter" →
  switchNecessary), rule chips/diffs (via shared requirementText/
  requirementId helpers), explain-service facts, and level validation all
  updated. Suite at 121.

## Sep 13 (art-direction and craft pass — external session, verified)

- **A second session's art/craft pass was reviewed and shipped** (`ea38d70`):
  per-scene material palettes (`src/render/art-direction.ts` — limestone
  vault, ivory observatory, patinated relay works, basalt lockhouse;
  presentation-only, nothing enters the level schema), crafted edges
  (RoundedBoxGeometry without touching catalog collision bounds), true
  ramp geometry (vertex-displaced, orientation-exact), a rewritten
  state-driven mechanism module (`src/render/mechanisms.ts` — cleaner than
  the event-callback version: state, not event ordering, determines all
  visuals; in-flight collections cancel on restart), **Frame level**
  button, and a switch-shape legend (hexagonal openers vs triangular
  sealers — distinct shape AND color cues). The gallery levels were
  redesigned with richer semantics: Twin Keys now gates the gold wing
  behind the silver key with a powered return loop and a two-key
  (`requiresKeys`) vault; Overpass is a two-elevation relay circuit;
  Gauntlet is prepare/arm/commit.
- **Verification performed before shipping**: strict chain green (113
  tests — 34 new, including semantic gallery assertions like "cannot
  reach gold first or skip the power room"); deployed and live-checked —
  canonical trap arc with mechanisms slamming, ghost visible with the
  stranded note, all three gallery scenes Accepted with pixel-distinct
  palettes, legend rendering, Frame level restoring its pose. One false
  alarm during verification: a mid camera-glide screenshot read as 9%
  content fill; after settle the same scene fills 81%×95% — screenshots
  after scene changes need a 6s settle, not 2.2s.
- `.openai/` (tool-generated hosting config with a project id) added to
  `.gitignore` rather than committed.

## Sep 12 (seam guards — the onChange regression can never recur silently)

- **Prompt-panel interaction tests added** (`tests/prompt-panel.test.tsx`,
  jsdom + React Testing Library): typing updates the controlled value
  **across a forced re-render** (a missing onChange only reverts on the
  next render — the naive assertion would pass), Compile submits exactly
  the typed prompt (with onChange missing the button stays disabled and
  the spy never fires), disabled-when-empty, and the selection→Keep-these
  chip flow. **Mutation-verified**: with onChange temporarily removed,
  three of four tests fail; restored, all pass. The dead-prompt-box deploy
  could not happen green again.
- **`npm run verify` added** as the single strict command
  (typecheck && lint && test && build) — the pipefail chain is now the
  easiest path, not a discipline to remember.

## Sep 12 (verification discipline — advisory catch)

- **A piped-verification hole was caught and closed**: `;`-chained checks
  piped through `tail`/`grep` reported success while lint had four errors,
  and the commit went through. Fixed (`e2470fb`), and verification now runs
  as `set -o pipefail && typecheck && lint && test && build` with commit
  inside the chain — a failing check stops the push. The lint errors
  themselves were emitted-code-identical (type import, let→const), so the
  deployed bundle was never wrong, but the process was.
- README refreshed for selection, keep-this, and save/share/remix;
  `docs/creator-session-script.md` written as the §14/§17 session protocol
  (six beats: warm-up, free build, intentional break, read the failure,
  choose a repair, share — measuring hesitations, surprises, and
  checker-caught-what-they-missed moments).

## Sep 12 (items 4 and 6 — preservation constraints; save, share, remix)

- **"Keep this" preservation constraints shipped** (§9, user-approved
  review item 4): select entities in the scene → **Keep these** → the
  repair search excludes any candidate that moves, removes, or reconditions
  them, and reports the count ("1 skipped to keep your choices"). Kept
  entities wear cream outer rings and brass chips; the honest empty state
  reads "No checked fix keeps those entities — try unkeeping one." Live
  semantics: keep the seal-switch → only the door-removal repair remains;
  keep both switch and door → zero candidates, reported honestly.
  Interaction hardened after review: protections **void stale repair
  results and previews**, and `applyRepair` independently refuses a
  candidate that touches a kept entity — a candidate found before the
  protection was set can never apply. Three interaction tests cover the
  invalidation, the apply-time guard, and unkeep restoring the full set.
- **Saving, sharing, and Remix shipped** (§12, user-approved amendment to
  the §15 no-persistence non-goal: **local saving + URL sharing only, no
  accounts, no database**): **Save** stores the current working level in
  localStorage (up to 20, "My puzzles" group in the scene picker);
  **Share** copies a `?p=<base64url>` link whose payload is canonical,
  schema-exact JSON (no extra fields — strict validation would reject
  them; round-trip and tamper tests cover the codec). A shared link opens
  **directly in play mode** with the exit button relabeled **"Remix this
  puzzle (Esc)"** — live-verified end to end: save → share → fresh open
  lands playing → Remix returns to authoring with the level Accepted and
  every check green. Truncated or tampered links fall back to the default
  scene; they can never inject an invalid level.

## Sep 12 (review top-3 — visible mechanism state, repair comparison, selection)

External review's three priorities, all shipped and live-verified:

- **Visible mechanism state** (`abbad94`): doors are no longer static
  frames — every keyed/sealing door carries a **portcullis slab** whose
  openness is decided by `doorPassable()` against the live actor state.
  Keyed doors rest locked and swing open when the key is held; sealing
  doors rest open and **slam** the moment their switch fires. Keys vanish
  into inventory on collection; switch plates depress and rims light.
  Actors report state; the engine decides. Verified through the full trap
  arc (6 state transitions to stranded) and the play arc — where the
  player collecting the key first, then pressing the switch, walks
  through the open vault door and wins: the trap's lesson, self-demonstrating.
- **Repair before/after** (`3820e1e`): repair cards **Preview** in the
  scene first — old positions ringed fail-red, proposed positions
  pass-green — with a template-derived consequence sentence ("The sealing
  door stays exactly as you built it — only the trigger moves."). Apply
  then offers **Replay the failing route**: the exact witness moves that
  failed, replayed on the repaired scene, ending "Route complete — the
  same moves no longer strand the player." (engine-guaranteed honest: the
  repaired level passed full verification, so no route can strand).
- **Selection-based prompting** (`9a5f981`): click any floor, key, switch,
  door, spawn, or goal in the scene (click-not-drag vs orbit) — brass
  selection rings, chips in the prompt panel, and the ids ride the compile
  request so "this door" / "here" resolve deterministically. Live proof:
  select lower-hall, type "Put a switch here." → model places the switch
  on lower-hall. Selection participates in the cache key.
- **Honest regression note**: the selection deploy briefly shipped a
  dead prompt textarea (an edit dropped the controlled input's onChange,
  so typing never reached React state and Compile resubmitted the last
  chip text). Caught during verification, fixed and redeployed same hour.
  Lesson recorded: every deploy that touches the prompt panel needs a
  type-into-the-box check, not just chip clicks.

## Sep 12 (review hardening — six implementation gaps, all fixed)

External review found six gaps; all verified real, all fixed
(`66 tests`):

1. **Wire schema lacked `requiresKeys`** — the strict JSON-Schema sent to
   structured-output providers now includes the multi-key array (nullable
   placeholder, normalizer-stripped), so non-Gemini models can emit it too.
2. **Stale results could apply across a scene change** — `submitPrompt` now
   binds to `revisionId(base)` and discards results when the scene moved
   during the request ("The scene changed while compiling; the result was
   discarded."). Live-verified: mid-compile scene switch → discard message,
   target scene untouched.
3. **Results did not carry a base revision** — the OK response envelope now
   carries server-attached `baseRevision` (never model-emitted; the model
   cannot know it), asserted client-side against the bound revision.
4. **Provider error kinds collapsed** — failed attempts record `errorKind`
   (rate_limited / timeout / budget / outage / unknown), the error response
   carries `providerError`, and the client renders it ("compilation_failed
   (rate_limited)") — honest telemetry for the judging window.
5. **90s service deadline vs 60s platform maxDuration** — deadline is now
   52s and every attempt's timeout clamps to the remaining budget
   (≥4s floor), so no attempt can straddle the platform kill and every
   failure is a clean error, never FUNCTION_INVOCOCATION_FAILED.
6. **docs/architecture.md and docs/movement-model.md absent** — both written
   from the current code (module map, hard boundary, revision model,
   compile policy, cache; kit, doors incl. requiresKeys, state bound,
   measured timings) and linked from the README.

## Sep 12 (items 4/5/6 — from-scratch generation, twist, kit breadth)

- **From-scratch generation shipped and measured**: a **Blank canvas** seed
  (spawn → walk → goal, trivially green) in the scene picker. The battery's
  new `scratch` class (6 whole-puzzle phrasings, engine-graded with rule
  approval simulated): **6/6 accepted builds** (4–6 modules added each,
  ~$0.014/build). The initial 0/6 was a **measurement artifact with a real
  root cause**: the provider's default `max_tokens: 2000` truncated
  multi-operation JSON into guaranteed schema failures — raised to 8000 for
  the Gemini models (cap, not charge; only actual tokens bill). The battery
  script also had an error-path bookkeeping bug that recorded $0 cost and
  hid attempts for failed compiles, making schema failures look like
  provider outages — fixed; error bodies now record attempts and cost
  honestly.
- **Suggest a twist shipped**: a universal chip whose canned prompt asks the
  model for one mechanic that fits the current scene. Measured 2/3 (the
  third a pre-token-fix casualty); live on production against the Gauntlet
  it produced the product thesis in one click: model proposed a trap →
  **Recovery=fail, 14 red stranded floors, stranded witness ready** for
  repair. A twist that breaks the puzzle is a PASS by design — the engine
  judging it IS the product.
- **Multi-key doors shipped (`requiresKeys`)**: AND semantics — every listed
  key must be held (≤3, one per kit key). Schema, movement
  (`doorPassable`), level validation (dangling references rejected),
  renderer (one keyhole gem per required key, fanned across the lintel),
  and system-prompt documentation. Live proof: "Make the outer vault door
  require both keys" on The Twin Keys compiled to
  `requiresKeys: ["silver-key","gold-key"]` with all checks green — the
  model adopted the new condition from prompt documentation alone. Suite at
  64 (AND-blocking, validity, checker, dangling-ref tests).

## Sep 12 (competitive depth — self-repair, verification viz, gallery)

- **Patch self-repair shipped** (`b3f0238`): the compile service now
  pre-applies every patch and rule_proposal with the same core the client
  uses; an engine-rejected patch never reaches the user — it gets one
  correction turn carrying the engine's exact reasons ("overlaps at
  (2,1); check the occupiedGrid"), then the fallback. New attempt outcome
  `rejected` in the wire contract; rule_proposal geometry is pre-validated
  too, so an approval can never strand the author with a broken level.
  Battery + retries: **28/34 (82%) effective**, zero client-side
  rejections; the loop itself verified live (one rejected→corrected→trap
  conversion). Five persistent failures were provider `schema_invalid`
  during a degraded window (12–14s latencies) — re-runnable for $0.16.
- **Verification visualization shipped**: the Report now carries a
  per-module `recoveryMap` (stranded/unreachable, computed only when
  exploration is complete — an incomplete map would be a silent lie). The
  renderer draws translucent floor decals: **red tiles can strand a player,
  dimmed tiles are unreachable** — the exhaustive search made visible.
  Pixel-verified on the trap fixture (1,419 red-tinted pixels over exactly
  bridge-landing + vault-approach; 0 in play mode — overlays are the
  author's view and never spoil the puzzle). A legend line appears in the
  checks strip only when there is something to say. Trap map:
  `[bridge-landing, vault-approach]`; ramp-removed: start stranded, the
  whole upper floor dimmed.
- **Gallery shipped** (`7613267`): a scene picker with three hand-authored,
  engine-verified showcase levels — **The Twin Keys** (2 keys, 2 rules, 2
  keyed doors, 35 states), **The Overpass** (a sky bridge crossing directly
  over a lower corridor — true floor-over-floor, confirmed legal by the kit
  and rendered 3× the steel-blue pixel count of bridge-less scenes), and
  **The Gauntlet** (a winding climb with a bonus-room sealing door the
  checker proves can never strand anyone — recovery clean by construction).
  All three accepted with clean recovery maps, live-verified on production.
  Hand-authored for determinism (the degraded provider made same-day API
  authoring impractical); API-authoring the gallery remains a future
  reliability exhibit when the provider is healthy.

## Sep 12 (reliability battery — model decision by measurement)

- **Eval allowance raised to ~$1** (user-approved ~$10 total budget) for one
  systematic battery; total spend across four full runs: **$0.249**
  (`scripts/reliability.ts`, 30–34 phrasings per run, all graded by the
  deterministic engine — the engine is the oracle, no human judgment).
- **Battery 1 (flash-lite, prompt-4) exposed the never-tested bypass class:
  0/5** — two modes: bridges placed on occupied cells (overlap rejection)
  and ids invented from labels ("upper-gallery"). prompt-5 added
  occupancy + id rules; **prompt-6 added a 16×16 occupancy grid to the scene
  summary** — neither moved flash-lite (bypass still 0/5; trap 4/11 fresh).
  Verdict: a model capability ceiling for multi-constraint spatial
  composition, not a prompt defect.
- **Model flip measured**: primary switched to `google/gemini-3.7-flash`
  (fallback `google/gemini-2.5-flash-lite`), same battery: **trap 10/11,
  bypass 3/4 real responses, compound 2/2, edits/unsupported/rule-weakening
  clean; ~93% valid overall** on non-outage responses (4 provider outages at
  $0 = battery rate-cadence artifact, not product behavior). Cost ≈
  $0.005/fresh compile → ~2,000 fresh compiles on the judging budget.
- **Grader lessons recorded**: baseline "failures" under 3.7-flash were valid
  puzzles with the keyed door on the treasure edge instead of the approach
  edge (both are sound "vault door" readings — grader now accepts either);
  battery-1's trap 5/7 was inflated by prompt-4-era cache hits mixing with
  fresh calls — **only fresh calls measure reliability; caches pin history**.
- **Canonical demo strings re-verified fresh under the new model**: prompt 1
  accepts (all green), prompt 2 traps with the stranded witness, compound
  one-shot traps. The model flip invalidated every cache entry — the video
  warm-up protocol must re-run under the final config (done for the arc).
- **Config now live**: `LLM_MODEL=google/gemini-3.7-flash`,
  `LLM_FALLBACK_MODEL=google/gemini-2.5-flash-lite` (env, .env.example, and
  README disclosure updated).

## Sep 12 (Phase 2b — repair template breadth, §9)

- **Two new repair families shipped** (allowed now that the §8.4
  unfamiliar-layout gate has passed): **trap dissolution** (drop the sealing
  condition and switch, or remove the sealing door outright) and **key
  relocation** (move the required key onto the bypass route — keys are
  collected on arrival, so the shortcut can no longer skip it; full
  re-verification proves every winning route then honors the rule).
- **Ranking extended with a removals dimension**: repairs that keep every
  entity now outrank destructive ones, ahead of the existing
  fewer-changed/fewer-ops/canonical tuple. The §8.2 canonical relocation
  still ranks first for the trap; the removal variants follow.
- **Measured** (tests/search.test.ts spike logs): trap — 7 candidates
  enumerated, **3 checked fixes** (relocation, remove door, remove switch),
  4.9 ms; bypass — 5 enumerated, **3 fixes** (two gates + move-key onto
  bridge-landing), 2.9 ms. All inside the ≤24/≤4 bounds; live-verified on
  production ("3 checked fixes found. 7 candidates checked in 4.8 ms").
- Suite at 51 (trap test updated from "exactly one fix" to the ranking
  contract: relocation first, every later candidate destructive but
  fully re-verified).

## Sep 12 (Phase 2a — api/explain, grounded failure narration)

- **Shipped and verified live**: `POST /api/explain` + "Why did this fail?"
  button on every failed check. The server **recomputes the verdict with the
  shared core** from the submitted level (the client never supplies one;
  non-failing checks are refused with 422), builds an authoritative fact
  sheet (engine explanation, requirements, witness route with per-move
  events, missing keys), and the model's only job is to phrase it — one
  paragraph, 2–4 sentences, ≤ 70 words, second person. Output is
  schema-validated **and grounding-checked**: any hyphenated token that is
  neither a real id nor a hyphenated form of a known module label invalidates
  the attempt (labels accepted because "upper-foyer" is a scene fact).
  ≤ 3 attempts like compiles; exact-match cached; costs disclosed in the UI
  ("Fresh explanation · model · $0.00016 · 1 attempt").
- **Live sample (production, trap fixture)**: "On the witness route, you
  reach 'vault-approach' and activate the 'seal-switch'. This closes the
  'gallery-door' behind you. Since you are at 'vault-approach' without the
  'brass-key', you cannot open the 'vault-door' to reach the
  'treasure-landing', leaving you stranded." — accurate, fully grounded.
- **Two en-route bugs fixed**: (1) core files imported siblings without
  `.js` extensions — fine under Vite/vitest but `ERR_MODULE_NOT_FOUND` in
  the Node-ESM serverless bundle once /api/explain pulled `verifier.ts` in
  (the compile path had only ever imported the extension-clean
  `serialize.ts`). All core/state/ui/render relative imports now carry
  explicit `.js` (TS-mapped), making the core genuinely portable into any
  Node-ESM context. (2) The primary model wraps JSON in a markdown fence —
  reusing `normalizeWirePayload` from the compile path fixed it; explain now
  succeeds on the primary in one attempt at **$0.00016** (was $0.0045 via
  the fallback before the fix).
- **Tests**: 7 new (grounding accept/reject, engine-refuses-non-failing,
  grounding-retry-then-correct, fail-closed on outages, exact-match cache,
  per-check cache separation) — suite at 51.

## Sep 12 (Phase 1 — judge experience + scale evidence)

- **Example chips shipped** (deployed `index-BttU0Z2F`): three one-click
  prompts under the Describe-a-change box. The trap chip is state-aware —
  on a fresh scene it sends a **one-shot compound prompt** (baseline + trap
  in a single compile; the model encodes the keyed door as a door condition,
  so no rule-approval step); once any key exists it sends the canonical
  second prompt. Both orders verified live on production: **direct →
  Recovery fail + stranded witness; sequential (chip 1 → chip 2) → same**.
  The compound string is recorded in `src/ui/example-prompts.ts` alongside
  the canonical arc strings.
- **Scale evidence recorded** (`scripts/stress.ts`, tsx-run): verify() on
  generated open grids — 36 modules/4,160 states → 31 ms; 81/9,920 → 41 ms;
  144/17,984 → 65 ms; **256 modules (kit max)/32,320 states (at the
  32,768 bound) → 138 ms** — one-and-a-half frames at absolute worst case,
  so main-thread verification stands (§11: Worker only if input-blocking).
  Repair search on the trap fixture: 2.7 ms, 1 candidate. On an open plane
  the repair search honestly returns zero candidates (nothing gateable) —
  the "no checked fix" path is reachable by construction.
- **Cache reality check**: the demo-path cache is in-memory and
  instance-local by design (§10.2 note in `api/_lib/cache.ts`) — a cold
  serverless start begins empty. So cache-backed determinism holds within a
  warm instance window, not across cold starts. **Video protocol: warm the
  exact demo sequence immediately before recording, then record within the
  warm window** (each cache hit also keeps the instance warm). For the
  weeks-long judging window, cold-start judges simply get fresh compiles at
  measured reliability (canonical trap 3/4; compound 1/1 sampled) —
  honest and disclosed by the Fresh/Cached badge. A persistent cache
  (Vercel KV) is optional hardening, not required.
- **Tab-wear note**: a long-lived headless tab accumulated puppeteer
  protocol timeouts and then silently dropped results that a fresh tab
  handled fine — a test-harness artifact, not product behavior. Verify
  suspicious UI failures in a fresh tab before debugging the app.

## Sep 12 (prompt-4 — trap reliability, measured)

- **The signature trap was unreachable by prose**: a 4-phrasing experiment
  on production (fresh load → prompt 1 → rule approve → prompt 2, each
  ~$0.0004) returned **0/4 traps**, with the failure mode exposed in the
  rejections: the model invented new *modules* for doors/switches
  (`gallery-door-module`, `seal-switch-module`, `gallery-ramp-top`) that
  overlapped existing cells. Core validation correctly rejected every one —
  the guardrails work; the model just didn't grasp doors-as-edges.
- **System-prompt fix (prompt-4, commit below)**: three added KIT RULES —
  doors/switches/keys never require new geometry (addDoor takes existing
  ids; addItem takes an existing moduleId); a closesAfterSwitch door
  starts open and seals when the switch activates; the stranded-player
  outcome is named as the intended pattern. PROMPT_VERSION bumped to
  `prompt-4` (cache key per §10.2, so stale prompt-3 entries are not
  reused).
- **Re-test after the fix: 3/4 phrasings trap** (Recovery=fail with the
  stranded witness); the one miss compiled cleanly (semantic placement,
  not a crash). Total experiment cost: ~$0.003 against the $0.25 eval cap.
- **Canonical demo phrasing locked and verified deterministic**: "Add a
  switch named seal-switch on the vault approach, and a door named
  gallery-door between the gallery and the bridge landing that closes
  permanently after the seal-switch activates." Two consecutive full runs
  (fresh load → prompt 1 → prompt 2) both returned **Cached compile with
  Recovery=fail** — the §10.2 exact-match cache makes the video's 20–35s
  money shot reproducible and free on demo day. Prompt 1 is likewise
  cached. The video script should use these exact strings.

## Sep 12 (diorama overhaul — §3/§12 renderer)

- **Vision-model critique of five diorama states scored 3.7/10** (default,
  baseline, trap, ghost playback, play mode) against an AAA-calibrated
  rubric, versus ~9.5 for the shell. Root causes, all source-grounded: no
  shadow maps at all; a fixed far camera ignoring level bounds; the ghost
  a translucent capsule with no trail; three near-identical golds
  (key/keyed-door/goal) and three competing reds (seal-door/switch/ghost);
  flat-disc goal and unreadable switch silhouettes.
- **Overhaul landed and deployed** (commit `6c5669c`): PCF soft shadow maps
  with a 2048px sun + hemisphere fill; ACES tone mapping; a dark stage disc
  that catches the level's shadow; **geometry-aware camera fit** (binary
  search over every module footprint's projected screen extent — the vault
  is L-shaped, so a bounding-box fit wasted its corners, measured 52% fill
  vs 71%+ after); follow-with-zoom during ghost playback (≈0.3× fit
  distance) that glides home and releases control; ghost presence =
  emissive body + back-face outline + wisp tail + under-ring + a decay-1
  red point light + a deep-red route tube ending in a ring and vertical
  destination beam; semantic palette split (goal = shell pass-green with a
  real light, brass shared by key + keyed door, one dark-crimson danger
  family for seal door + switch); authored silhouettes (floating key with
  bow/shaft/teeth, pressure-plate switch with rim, goal pedestal + rotating
  gem + halo, door type telegraphs); proper disposal of all created
  geometry/materials.
- **Reduced-motion contract preserved**: decor spin/bob, camera spring, and
  ghost pulse all gate on the live media query; stepped ghost and instant
  camera snap unchanged.
- **Two engineering findings en route**: three.js ≥r155 uses physical light
  units, so cm-scale scenes need candela-scale point-light intensities
  (intensity ≈ illuminance × distance²; decay-1 lamps chosen for readable
  pools); `page.evaluate` in this harness runs in an isolated world —
  window globals set by app modules are invisible to it, DOM datasets are
  the shared channel.
- **Post-overhaul critique plateaus at ~5.5–6.5** on the AAA rubric: the
  remaining deductions (bevels, textures, AO, character rigs) are outside
  §15's design contract — the kit is three primitive templates by
  specification. On the product's own bar the transformation is complete:
  ghost 2.5 → dominant focal point with route narrative; measured fill
  52% → 71%+; zero shadows → staged, grounded scene; colliding palette →
  semantic families matching the shell tokens.
- **Also observed (pre-existing, unchanged): the trap is hard to reach by
  free-form prose** — two natural-language phrasings of prompt 2 compiled
  successfully but produced non-trapping door conditions (recovery stayed
  green). The demo needs a rehearsed canonical phrasing or prompt-2
  reliability work before the video.

## Sep 12 (design-critic loop — §12 shell)

- **Ten independent design-critic rounds run against the deployed shell**,
  each with fresh measured evidence (computed styles, pixel statistics,
  live flows) and a fixed eight-axis rubric; every round's improvements
  implemented, browser-verified, and deployed before the next critique.
  Score trajectory: **6.4 → 9.2 → 9.4 → 9.3 → 9.3 → 9.6 → 9.6 → 9.6 →
  9.6 → 9.4** (the final round's critic discovered a mobile regression
  introduced by an earlier round's fix — sticky strip occluding the panel —
  since corrected by pinning only a short head+verdict fragment, verified
  at 390×844).
- **~110 improvements landed across the rounds**, including: identity
  typography (Space Grotesk Variable + IBM Plex Mono, self-hosted);
  four-step tokenized type scale; three-layer reduced motion; WCAG
  AA/1.4.11 contrast verified numerically across every pair; complete
  button state matrix with coarse-pointer targets; collapsible inspectors;
  verdict-forward sticky strip; armed two-stage destructive reset with
  tracked timer; live-region discipline (verdict, compile outcomes, move
  progress, errors); keyboard orbit with play-mode ownership swap; focus
  management on mode changes; favicon/theme-color/::selection/scrollbar
  polish; mobile mode-aware panel caps with a pinned verdict fragment.
- **Convergence behavior:** the independent critic asymptotes at ~9.5–9.6,
  each round surfacing a new micro-layer (sub-perceptual type steps,
  mobile panel-share trade-offs, live-region chatter). The remaining
  0.1–0.2 to a 9.7+ is a long tail of increasingly theoretical items, not
  a single fixable gap.

## Sep 12 (complete loop — §14 Sep 26 gate, early)

- **Every Sep 26 gate item is verified live on the deployed URL:**
  - **Prompt 3 (§8.3) end to end:** two honest rejections first (label used
    as an id; walkway routed through occupied cells), then the §10
    fallback fired in production — flash-lite failed schema twice and
    gemini-3.7-flash placed the walkway correctly (3 attempts, $0.010).
    The bypass diagnosis is exact: solution pass, requirement fail
    (keyless winning route), recovery pass. Bypass ghost: “Reached the
    goal without: brass-key.” Repair search found both entrance gates
    (2.4 ms); applying one → Accepted, rule preserved.
  - **Unfamiliar layout gate (§8.4, held out from all prompt work):** the
    seed verifies green; a natural-language bridge edit produced a correct
    playable diagnosis — requirement fails with the iron-key bypass,
    recovery holds, bypass ghost replays — with no fixture-specific logic.
    Honest caveat: it took several attempts and finally explicit cell
    coordinates plus the fallback model; flash-lite's unaided spatial
    composition on novel layouts is not demo-grade, consistent with
    docs/model-eval.md. The rejection → rephrase → clarification →
    fallback chain carried every failure safely.
  - **Clarification:** the model asked bridge-orientation questions with
    entity-bound choices; choosing resubmits with clarification context
    (context participates in the cache key).
  - **Unsupported:** the jump request returns real supported alternatives.
  - **No checked fix:** removing the spiral stair disconnects the goal;
    the search reports “No checked fix in this search. 0 candidates
    checked in 0.2 ms.” — honest, with discard available.
- **Stale-result hardening:** pending rule proposals are cleared whenever
    the level changes (a stale approval can never apply to a moved-on
    base), and failed compiles clear the previous result card.
- **Session spend ≈ $0.025.**

## Sep 12 (ghost, play, repair — §14 Sep 13 gate)

- **The signature moment is live on the deployed URL.** The ghost walks
  verifier witness routes along catalog polylines at constant speed
  (300 cm/s), inventory appears as it happens, the camera follows, and it
  holds at the trapped state pulsing. Restart / pause / step verified in a
  real browser. Manual play (WASD/arrows, R, Escape, on-screen d-pad) walks
  the same core `step` — one transition per input — and calls out
  "You reproduced the failure" when the player's exact state matches the
  dead-end witness state.
- **§9 repair search landed early.** Both first-slice templates
  (gate-the-new-route, relocate-the-trapping-switch), ≤24 candidates, ≤4
  ops each, full recheck per candidate, deterministic ranking. On the trap
  it finds exactly one checked fix — move the seal switch behind the vault
  door — content-identical to the §8.2 repaired fixture. Applied live: the
  draft went from recovery-fail to all three checks green with the rule
  preserved.
- **Measured (§14 Sep 13 evidence):** verification 0.6 ms (golden
  fixtures); repair search 2.1 ms (trap, 5 candidates) and 0.9 ms (bypass,
  2 candidates) in tests, 4.1 ms live on the serverless instance. Golden
  timings are not worst-case; stress layouts remain front-loaded.
- **Bug found and fixed in verification:** the ghost's progress note
  emitted the move index before incrementing (one-move lag) — caught by
  browser-driving the controls, fixed, redeployed.

## Sep 12 (live compile flow)

- **The §14 Sep 14–15 gate is live early on the deployed URL.** `POST
  /api/compile` (Vercel function) validates requests strictly, runs the
  three-attempt bound (primary → schema-correction retry → evaluated
  fallback) with usage accounting and a 90 s service deadline, and serves
  the full-input demo cache. The client applies results atomically through
  the shared core: prompt 1 → rule proposal → explicit approval → all
  three checks pass; prompt 2 → patch → the designed trap (solution pass,
  requirement pass, recovery fail with the stranded vault-approach
  witness). Verified in a real browser against production.
- **Prompt iteration v3 disclosed:** two generic contract clarifications
  (explicit `"type"` envelope; "door conditions are ordinary scene edits,
  not design requirements") after live misfires. The model's ~50% P2
  semantic rate is the known eval finding — a goal-deadlocking variant is
  handled honestly (draft labeled, return to accepted) and the demo-path
  cache replays the rehearsed good response deterministically.
- **Cache verified live:** an identical prompt returns "Cached compilation"
  with no provider call; a different prompt or clarification context
  misses by design. Cache is instance-local — a cold start means fresh
  calls, never stale verdicts.
- **Live session spend ≈ $0.002** across ~7 calls.

## Sep 12 (model selection)

- **§10.1 evaluation complete; no model meets the full bar.** Six models
  evaluated through the real gateway (12 fixtures × 2 uncached runs each,
  deterministic grading through `applyOperations` + `verify`). Best
  first-try semantic correctness is 50% against the 90% bar; best final is
  67%. Recorded in `docs/model-eval.md` rather than forced — invalid
  output is never accepted to hit a target.
- **Chosen configuration: `google/gemini-2.5-flash-lite` primary,
  `google/gemini-3.7-flash` fallback** (the evaluated fallback of §10's
  three-attempt bound). Flash-lite is the only model passing both absolute
  safety gates (4/4 ambiguity, 2/2 rule-protection) at 1.5 s median and
  ~$0.0003/call; its failure classes (spatial placement, placeholder ids)
  are the fallback's strengths. Rejected: deepseek models (quality and
  55 s latency), gpt-oss-120b (2/4 ambiguity), qwen-plus (3/4 ambiguity
  after the final prompt iteration).
- **Wire contract:** Gemini models reject strict structured output for our
  vocabulary ("too many states") and run fence-stripped plain JSON with
  strict Zod validation; the OpenAI-compatible models use a per-type anyOf
  strict envelope. Reasoning effort low everywhere it applies.
- **Evaluation spend: $0.225 of the $0.25 cap**, including two
  defective-configuration runs and diagnostics, all disclosed in the eval
  doc.

## Sep 11 (minimal scene deployed)

- **Minimal deployed scene live at `https://levelproof.vercel.app`**
  (Vercel, Vite auto-detected, first deployment promoted to production).
  The diorama renders from the compiled core through imperative three.js;
  the check strip shows the three results with revision identity,
  explored-state count, and verification duration surfaced; a fixture toggle
  switches between the baseline (all checks pass) and the switch trap
  (recovery fails with the stranded-at-vault-approach explanation).
  Verified in a real browser against the deployed URL, not only locally.
- **Scaffold styling only** — the designed §12 shell (technical tone,
  Hallmark pass) replaces it; custom-property tokens keep the seam clean.
- **Deployment note:** deployment-hash URLs sit behind team SSO (standard
  deployment protection); the public entry point is the production domain.

## Sep 11 (core engine)

- **Core engine landed** (first half of the §14 Sep 11–12 gate): strict Zod
  schemas and the bounded edit vocabulary (`shared/schema.ts`); versioned
  catalog `catalog-1.0.0` (400 cm pitch, 300 cm spacing, 160 cm player,
  25 cm radius); FNV-1a revision identity (`serialize`); geometry-derived
  connectivity with overlap/headroom rejection (`topology`); semantic
  validation and atomic patches with rule protection (`level`); the single
  `transitions`/`step` movement engine shared by player, ghost, verifier,
  and search (`movement`); bounded BFS with the three separate checks and
  replay-checked witnesses (`verifier`); baseline and trap golden fixtures.
- **Measured spike evidence (golden fixtures only — not worst case):**
  baseline 17 explored states, trap 19, both verifications 0.6 ms combined.
  Stress layouts near the configured limits are front-loaded into spike
  week per the Sep 11 decisions.
- **Suite: 28 tests green** across movement derivation, verification
  semantics, and patch atomicity; strict typecheck and lint clean. The trap
  fixture's recovery witness matches the spec exactly, and the trap built
  through the ordinary patch path has identical revision identity to the
  fixture.
- **Provider key loaded by the owner** into local `.env` (gitignored and
  deployment-excluded; presence-checked without ever printing the value).
  OpenRouter credit ~$10 with the $4.50 per-key spend limit enforced. The
  §10.1 model evaluation is unblocked once the provider adapter exists.

## Sep 11

- **Repo and provenance.** Public workspace initialized; private pre-window
  notes (`levelBuild*.md`, `newVRidea*.md`, `taskproof.md`) excluded from
  commits (`.gitignore`) and CLI deployments (`.vercelignore`). Private notes
  remain in the working directory by owner's choice; deployment-content
  verification is therefore added to every milestone gate.
- **Polish order amended.** A world visual-quality spike (materials, lighting,
  prop readability) moves from the Oct 11 polish phase into Sep 11–15.
  Rationale: judges form impressions in the opening seconds of the video; the
  original order deferred world visuals past that point. Ghost motion and
  camera choreography remain first.
- **Layering legibility** is an explicit camera requirement for the bridge
  segment of the video (show the bridge crossing above a lower route).
- **Measured rigor surfaced.** The check strip shows the explored-state count
  and verification duration from the report, next to the three results.
- **Model evaluation scheduled for the week of Sep 11** (previously undated).
  Model choice cascades into prompts, cache identity, and the video; a failed
  §10.1 bar discovered late is unrecoverable. Eval cost cap unchanged.
- **Model pricing snapshot (live OpenRouter catalog, fetched Sep 11).**
  Eval slate for §10.1, all with native structured outputs and ≥128k context:
  `openai/gpt-oss-120b` ($0.037/$0.17 per M in/out), `deepseek/deepseek-v4-flash`
  ($0.086/$0.17), `google/gemini-2.5-flash-lite` ($0.0999/$0.40); alternates
  `qwen/qwen3.5-flash-02-23`, `meta-llama/llama-4-scout`. Estimated per-compile
  cost at 4k in / 1k out (envelope to be verified): $0.0003–0.0008; the full
  3-model × 24-call eval ≈ $0.05, inside the $0.25 cap. Fallback ladder if the
  bar fails: deepseek-v3.2 / qwen-plus (~$0.0015–0.0018 per compile), then
  gemini-3.x-flash / gpt-5.4-mini / claude-haiku-4.5 (~$0.004–0.009). Batch
  variants excluded (async turnaround); `:free` tier excluded (rate limits
  during judging).
- **Unfamiliar-prompt video segment** will be rehearsed against the deployed
  URL with pre-screened prompts — unfamiliar to the tool, not to the author.
- **Provider-failure rehearsal** (key killed mid-session) added to the
  Oct 26 – Nov 9 reliability window.
- **Front-loaded into spike week:** unfamiliar-layout authoring and
  stress-layout verification/search measurement.
- **Submission artifacts pulled ahead of the Oct 26 freeze:** short
  description, focus category, README trap GIF (captured at the Sep 13 ghost
  milestone).
- **Creator-session recruitment** is owned by the author; sessions still
  begin by Sep 26 and complete by Oct 11.
- **Budget.** The existing assumption holds pending the model evaluation;
  the lifetime ceiling is re-sized only if the evaluation forces a pricier
  model.
