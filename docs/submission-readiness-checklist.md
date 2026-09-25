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

## Still to verify against the live backend

- [ ] Full live backend prompt → preview → approve → play → save → reload →
  share → clean-context reopen.
- [ ] Live key-and-requirement removal preview and approval.
- [ ] “Show the problem” evidence highlights and replay in every theme.
- [ ] Backend outage, timeout, malformed response, and slow-response browser
  journeys.
- [ ] Production request limiter and provider spending cap verified in the
  hosting environment.

These are deliberately left unchecked until the browser run is performed with
the backend available.

## Existing local browser evidence

Earlier local Chrome checks covered normal-camera ghost readability, pause and
reduced-motion behavior, theme switching, and replay controls. They were not a
Safari or real-phone test and do not substitute for the live-backend journeys
above.

## Blocked or unavailable evidence

- Real iPhone/Android hardware: unavailable in the current workspace.
- Production GPU/CDN startup and backend: not rechecked; deployment and live
  configuration changes were not authorized.
- Safari: unavailable in the current browser surface.
- Outside tester: not available for this run.
- Live model calls: not run without an explicit cost/backend test window.
- Production deployment/configuration changes: intentionally not performed.
