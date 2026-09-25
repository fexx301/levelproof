# Judging-period operations checklist

Run this checklist before a judging session. No item authorizes deployment by
itself.

## Availability

- [ ] Open the production URL in a clean browser context.
- [ ] Confirm the frontend loads and the scene controls respond.
- [ ] Confirm the configured backend responds to `/api/compile` and
  `/api/explain`.
- [ ] Confirm the browser console has no new runtime errors.

## Configuration and cost

- [ ] Confirm the configured model and provider are the intended ones.
- [ ] Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the
  hosting environment. Production API calls fail closed without the shared
  request limiter.
- [ ] Confirm the rate window and daily request cap. These cap requests, not
  dollars; also set a hard spending limit with the model provider.
- [ ] Confirm API quota and provider spending limits.
- [ ] Confirm cache status is visible in the compile result metadata.
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
