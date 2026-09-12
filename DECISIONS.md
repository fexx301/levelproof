# DECISIONS

Build-window decisions and measured evidence, newest first. Dates are 2026.

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
