# Browser verification log

Updated 2026-09-19. Browser: Chrome via headed local tab at 1512×900, DPR 2.
The API used for this run was a local deterministic fixture wired through the
real `/api/compile` and `/api/explain` paths. It proves frontend/backend
contract behavior, not live model quality.

## Passed with the deterministic backend

- Prompt → preview: the canonical key request produced a two-operation edit
  preview and left the accepted scene unchanged.
- Preview → apply: approval accepted the exact staged candidate and showed
  “EDIT APPLIED — ACCEPTED”.
- Apply → play → exit: the accepted scene entered manual play and returned to
  authoring with Escape.
- Failure draft: the switch trap produced “Draft — not accepted”, Recovery
  failed, and the accepted checkpoint remained available.
- Show the problem: the replay opened with verifier-owned evidence, a focus
  module, implicated ids, and the stranded witness.
- Repair: the top checked repair previewed, applied, returned to Accepted, and
  offered the old witness route only after route revalidation.
- Repaired replay: the old route completed with “Route complete — the same
  moves no longer strand the player.”
- Save → reload: the accepted checkpoint remained in **My puzzles** after a
  browser reload.
- Share → clean tab: the copied accepted-scene link opened directly in play
  mode in a separate tab.
- Invalid share payload: a malformed `?p=` link fell back to the normal
  authoring scene without an error or scene mutation.
- Theme switching: the five theme options were selectable in the browser;
  theme-remount selection/protection persistence is additionally covered by
  `tests/app-scene-boundaries.test.tsx`.

## Not claimed by this run

- The API fixture was not a live model call.
- Live backend outage, timeout, slow-response, and invalid-body browser
  journeys were not run in this pass.
- Safari, a real phone, and an outside unfamiliar user were not available.
- Browser media emulation is not the same as changing the operating system’s
  reduced-motion setting.

## 2026-09-23 final production-preview Playwright run

Command: `npm run test:e2e -- --workers=1`. The final source was built in
production mode and served by Vite preview; Chromium 153 used software WebGL
(SwiftShader), a 1280×720 viewport, DPR 1, and one worker. The compile API was
fulfilled with deterministic, schema-shaped browser fixtures. No live model or
production backend call was made. The run passed **10/10 tests** in about 2.1
minutes, including eight interaction journeys and two performance samples.
Startup and replay measurements are in `docs/performance-report.md`.

- Pointer-clicked the visible gallery floor; the **Selected** chip and scene
  ring appeared. Selection and **Keep these** protection remained through
  Limestone ruin, Ivory observatory, Patina relay works, Basalt lockhouse, and
  Futuristic vault remounts. Captured and visually inspected one screenshot
  per theme; the renderer retained exactly one canvas after every remount.
- Added a brass key in a staged preview. The green proposed-position halo,
  plain-language operation, before/removed vs proposed/added legend, and
  **Apply edit** button were visible together in the ordinary overview camera.
  Reload recovered the unapproved proposal; approval applied that same
  candidate. Manual play reached **Goal reached**, then save → reload → share
  opened the accepted scene in a clean browser context.
- Approved a rule-linked key/door/requirement removal. The preview showed the
  requirement removal and both geometry operations; after approval, none of the
  three remained in the scene/rule list.
- Applied a deterministic switch-trap proposal as a draft, selected **Show the
  problem**, and inspected the decisive replay: it paused at the verified
  stranded witness, highlighted implicated objects/route, stated the causal
  verifier evidence, and returned to the repair preview and approval flow.
- Simulated an unavailable compile endpoint; the error remained recoverable,
  the prompt was retained, and Compile was re-enabled. A conflicting edit to a
  kept object was rejected without changing the scene; unkeeping it enabled
  retry.
- Forced WebGL initialization to fail; the 3D fallback appeared while the
  verification panel remained available.
- At 390×844, used keyboard focus and Enter to compile, approve, enter manual
  play, and move. Focus was visible, movement controls stayed in bounds, and
  the page had no horizontal overflow. This is not a real-phone test.

These journeys validate UI, renderer, and request/response behavior against
controlled fixtures, not live-model quality or live Vercel configuration. The
live API evaluation separately found incompatible deployed `baseRevision` and
protected-id contracts; see `docs/evaluation-report.md`. SwiftShader is not a
real-GPU performance measurement. The earlier headed Chrome result is
historical and was not reproduced on this build. This run did not test Safari,
a real phone, outside users, or operating-system reduced-motion settings.
