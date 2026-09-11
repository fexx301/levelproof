# DECISIONS

Build-window decisions and measured evidence, newest first. Dates are 2026.

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
