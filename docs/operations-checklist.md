# Judging-period operations checklist

Run this checklist before a judging session. No item authorizes deployment by
itself.

## Availability

- [ ] Open the production URL in a clean browser context.
- [ ] Confirm the frontend loads and the scene controls respond.
- [ ] Confirm the configured backend responds to `/api/compile` and
  `/api/explain`.
- [ ] Confirm the browser console has no new runtime errors.

## Deploy (only with explicit authorization)

- [ ] Set the model configuration **in the same change** as the code:
  `LLM_MODEL=google/gemini-3.8-flash`,
  `LLM_FALLBACK_MODEL=google/gemini-2.5-flash-lite`, `LLM_TIMEOUT_MS=45000`.
  The prompt-11 code on the older `gemini-3.7-flash` setting is slower than
  the previous production build.
- [ ] Optional: `SHARED_CACHE_TTL_SECONDS` (default 604800 = 7 days) and
  `LEVELPROOF_SHARED_CACHE=off` to disable the shared tier.
- [ ] `npm run verify` and `npm run test:e2e` pass on the commit being deployed.
- [ ] After deploy: confirm the stream arrives incrementally — open the
  blank canvas, type a new sentence, and watch the plan headlines appear
  before the preview. (If a proxy buffers the stream, the result still
  arrives; only the live feed is lost.)
- [ ] Prewarm every chip:
  `npx tsx scripts/prewarm.ts --confirm-live-ai --budget-usd 0.40 --url https://levelproof.vercel.app`
  and confirm a chip click shows “Cached result”. Re-run after any prompt
  version change and before judging windows (entries last 7 days).
- [ ] Rerun `eval:fixed:live` against production
  (`LEVELPROOF_API_URL=https://levelproof.vercel.app/api/compile`) and record
  the result in `docs/evaluation-report.md`.

## Configuration and cost

- [ ] Confirm the configured model and provider are the intended ones.
- [ ] Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the
  hosting environment. Production API calls fail closed without the shared
  request limiter.
- [ ] Confirm the rate window and daily request cap. These cap requests, not
  dollars; also set a hard spending limit with the model provider.
- [ ] Confirm API quota and provider spending limits.
- [ ] Confirm cache status is visible in the compile result metadata.
- [ ] The shared cache stores the full request identity, including prompt
  text, in Upstash for the configured TTL; keep that disclosure in the README.
- [ ] Do not run the live battery without recording timestamp, model, latency,
  cost, and repeat count.

## Failure visibility

- [ ] Test a rejected/unsupported request and confirm the prompt remains
  available.
- [ ] Confirm a backend error is actionable and does not change the accepted
  checkpoint.
- [ ] Confirm a saved malformed entry is visible and removable.
- [ ] Confirm **Return to accepted** restores the last accepted checkpoint.

## Rollback and response

- [ ] Keep the last known-good commit/build identifier.
- [ ] Keep the previous frontend deployment URL if a deployment is authorized.
- [ ] If the backend is unavailable, switch to the labeled deterministic backup
  demonstration rather than claiming live generation.
- [ ] Record the failure, timestamp, browser, and visible error before making a
  configuration change.
- [ ] Obtain explicit authorization before deployment, provider changes, or
  spending money.
