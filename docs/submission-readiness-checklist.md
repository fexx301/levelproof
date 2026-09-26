# Submission-readiness checklist

This is the delta checklist for the implementation in `refine.md`.

## Implemented and automatically tested

- [x] 30 fixed, schema-supported evaluation cases across six categories.
- [x] Atomic rule proposals for linked removals.
- [x] Preview and approval use the same validated candidate.
- [x] Malformed response and network failure paths fail closed and remain
  retryable.
- [x] Repeated approval is idempotent.
- [x] Saved drafts remain visible and editable; malformed saves remain
  removable; accepted checkpoints are preserved.
- [x] Saved-draft lineage is reset to the accepted checkpoint when drafts are
  opened in sequence.
- [x] Theme remounts rebind selection, protections, and evidence highlights.
- [x] Grounded failure evidence and “Show the problem” replay entry point.
- [x] Repaired witness routes are revalidated before replay.
- [x] Dismissible first-run guide reports actual progress and uses the real
  compile workflow.
- [x] `npm run verify` and `git diff --check` are required final checks.

## Browser-verified with a deterministic backend fixture

- [x] Prompt → preview → approve → play.
- [x] Intentional trap → draft → Show the problem → witness replay.
- [x] Repair search → preview → apply → revalidated witness replay.
- [x] Save → reload → share → clean-tab reopen.
- [x] Malformed shared-link fallback.
- [x] Pointer selection, selection/protection rings, and selected/kept chips
  across all five theme remounts.
- [x] Required key + door + rule removal preview and atomic approval.
- [x] Theme remount retains one canvas; recoverable API and WebGL failures.
- [x] Five cold/warm production-preview startup pairs with explicit
  software-WebGL conditions.

See `docs/browser-verification.md`. These checks prove the real UI and wire
contract, not live model behavior.

## Verified against the live backend (2026-09-26)

Run with `node scripts/live-journeys.mjs https://levelproof.vercel.app <out>
--confirm-live-ai` (Chromium with GPU, macOS). Result: **24/24 checks passed**.

- [x] Full live backend prompt → preview → approve → play (won by following
  hints) → save → reload → share → clean-context reopen, and the shared
  puzzle won again in the clean context. No page errors.
- [x] Live key-and-requirement removal: a fresh model call previewed the
  removal, approval removed the key and its door, and the level stayed
  winnable.
- [x] “Show the problem” evidence and replay in every theme (from the scene,
  limestone, ivory, patina, basalt, futuristic): each pauses on the decisive
  move with the evidence card.
- [x] Failure journeys on the production UI (API intercepted): network
  outage, server error, malformed response, switching scenes mid-request
  (cancelled with a notice), and a stalled connection (stopped by the
  130 s client watchdog). Each explains itself, keeps the prompt, and never
  leaves a spinner.
- [x] Production request limiter: a burst of ten requests from one address
  gets 400 for the first eight malformed bodies and 429 after that, before
  any model call. The provider spending cap is set on the OpenRouter key by
  the owner (not visible to this script).

## Existing local browser evidence

Earlier local Chrome checks covered normal-camera ghost readability, pause and
reduced-motion behavior, theme switching, and replay controls. They were not a
Safari or real-phone test and do not substitute for the live-backend journeys
above.

## Blocked or unavailable evidence

- Real iPhone/Android hardware: unavailable in the current workspace (Pixel 7
  emulation only: hold-to-run and taps verified).
- Production GPU/CDN startup and backend: rechecked 2026-09-26 (above).
- Safari: unavailable in the current browser surface.
- Outside tester: not available for this run.
- Live model calls: run 2026-09-26 with owner authorization (judge battery,
  $0.26; one live removal).
- Production deployments: performed with owner authorization.
