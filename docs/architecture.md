# Architecture

LevelProof is an AI puzzle creator with automatic playtesting: a language
model compiles plain-language intent into typed kit operations, and a
deterministic engine — the same code for the player, the ghost, the verifier,
and the repair search — decides everything about movement and correctness.

## Module map

```
shared/            Wire contracts shared by client, server, and tests
  schema.ts        The kit itself: modules, items, doors, requirements (Zod)
  compile-result.ts The four compile results; wire normalization
  api.ts           Request/response envelopes for /api/compile and /api/explain
api/               Serverless functions (Vercel)
  compile.ts       POST /api/compile
  explain.ts       POST /api/explain (grounded failure narration)
  _lib/            Provider adapter, system prompt, wire JSON schema, caches,
                   compile + explain services (attempt policy, self-repair)
src/core/          The deterministic engine — zero DOM/renderer/React/network
  catalog.ts       Integer-centimeter geometry; port and polyline definitions
  level.ts         Operations, application, and level validation
  topology.ts      Geometry-derived connectivity (ports must coincide)
  movement.ts      step()/transitions(): the single movement implementation
  verifier.ts      Bounded exhaustive exploration; the three checks; recovery map
  search.ts        Checked-repair templates; never weakens rules
  serialize.ts     Canonical JSON + revision ids
src/render/        Imperative Three.js diorama (scene, actors, overlays)
src/state/         Zustand store: one accepted level + at most one draft
src/ui/            React chrome (prompt panel, checks, playtester, repairs)
```

## The hard boundary

`src/core` is pure: no DOM, no renderer, no React, no network. The same
`step()` decides every move whether it comes from a keyboard, a ghost replay,
the verifier's exploration, or the repair search's candidate re-checks. The
model can never supply traversal edges, verdicts, witnesses, or raw level
JSON — it returns exactly one of `patch`, `clarification`, `rule_proposal`,
or `unsupported`, schema-validated, and patches apply atomically through
`applyOperations` (a dangling reference rejects the whole patch).

## Revisions (§11)

One immutable `acceptedLevel` plus at most one editable `draft`. Every
compile request names the level it targets; the response carries the
server-attached `baseRevision` it was computed against. The client binds the
request to a revision and discards results that return after the scene has
moved on. A passing edit auto-accepts; a failing or incomplete one stays a
labeled draft with **Return to accepted** always available. One-step undo.

## Compile service policy

At most three provider attempts: the primary model, at most one correction
retry (generic for malformed JSON; carrying the engine's exact rejection
reasons for a patch the core refused — **self-repair**), then the evaluated
fallback. Patches and rule-proposal geometry are pre-applied with the same
core the client uses, so a rejected edit never reaches the user. Everything
is cost-accounted per attempt; the whole service fits inside the serverless
platform's 60s ceiling (per-attempt timeouts clamp to the remaining budget).

## Cache and cost disclosure

Exact full-input identity: canonical level content, prompt, clarification
context, model configuration, and prompt version all participate in the key.
In-memory and instance-local by design — a cold start simply means a fresh
provider call, never a stale verdict. The UI always shows **Fresh compile**
or **Cached compile** with model, dollar cost, and attempt count in a
collapsible inspector. Explanations are cached and disclosed the same way.

## Verification contract

Three independent checks, each `pass` / `fail` / `check incomplete` /
`not applicable`: solution (any goal reachable, with a playable route),
design requirements (every reachable goal contains the required keys — a
keyless route alongside a keyed one still fails), and recovery (reverse
search from all goals; any reachable state that cannot win is a dead end).
Incomplete exploration is never green. Witnesses replay through the same
core `step()` from the real initial state or the result is an internal
error. The verifier also emits a per-module recovery map — stranded and
unreachable floors — which the renderer paints as overlays (hidden during
play so the analysis never spoils the puzzle).

## Failure narration

`POST /api/explain` recomputes the verdict server-side from the submitted
level (the client never supplies one; non-failing checks are refused), builds
an authoritative fact sheet from the engine's output, and asks the model to
phrase it — one paragraph, schema-checked and grounding-checked (any
hyphenated token that is not a real id or label invalidates the attempt).
The engine's verdict always stands on its own; the narration adds story,
never authority.
