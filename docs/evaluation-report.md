# LevelProof evaluation report

Updated 2026-09-23. This report separates controlled fixture evidence from
live-model evidence.

## Deterministic suite

The version-controlled suite is `src/core/evaluation-suite.ts`, exercised by
`tests/evaluation-suite.test.ts` and runnable with `npm run eval:fixed`.

| Category | Cases | Passed |
| --- | ---: | ---: |
| Simple edits | 6 | 6 |
| Linked changes | 6 | 6 |
| Gameplay logic | 6 | 6 |
| Preservation | 4 | 4 |
| Ambiguity | 4 | 4 |
| Unsupported/conflicting | 4 | 4 |
| **Total** | **30** | **30** |

The cases specify a starting level, prompt, controlled compile result, expected
semantic outcome, acceptable alternatives, must-not-change ids, and a
deterministic assertion. The gameplay cases intentionally include valid
unsolved drafts: a faithful trap or bypass is a successful evaluation of the
requested change, not an AI failure.

The fixed suite also checks:

- strict result parsing;
- atomic patch and rule-proposal application;
- preview/approval candidate equality;
- protection handling;
- unrelated-entity preservation;
- solution, requirement, and recovery statuses where applicable;
- safe clarification and unsupported responses.

Additional boundary tests cover malformed responses, retryable network errors,
duplicate approval clicks, saved-draft lineage, storage quota errors, theme
remount evidence bindings, and repaired-route revalidation.

## Live evaluation

Live calls are deliberately separate from the fixture score. Use:

- `npm run eval -- --confirm-live-ai --budget-usd 0.10 --models model-a,model-b`
  for direct provider evaluations;
- `npx tsx scripts/reliability.ts --confirm-live-ai --budget-usd 0.10` for the
  deployed `/api/compile` battery.
- `npm run eval:fixed:live -- --confirm-live-ai --budget-usd 1` for the exact
  30 version-controlled cases below, followed by two additional runs of one
  representative case per category. This grades the real backend response with
  the same deterministic semantic assertions as the fixture suite.

All live scripts are disabled by default, accept a software ceiling no higher
than $1.00, and stop if a completed request has unknown cost. The ceiling is
checked after each provider response; one request can exceed it, so a
provider-side hard spending cap remains necessary. The direct runner estimates
cost only from its dated pinned rate table when provider billing is absent;
unpriced models halt without retrying. The deployed battery requires numeric
billing metadata and treats cache hits as zero-cost requests. The runners
record timestamp, model/configuration, category, cache status, attempts,
latency, cost, response type, semantic grade, and error details. The three
golden direct-evaluation cases are repeated three times; remaining cases run
twice. Reports go to `/tmp/reliability.json` and `/tmp/model-eval.json`.

### Latest synchronized full rerun

On 2026-09-23, after the current frontend and API were deployed together, the
exact 30 cases plus 12 representative repeats completed at
`https://levelproof.vercel.app/api/compile`. The raw report is
`/tmp/levelproof-live-evaluation.json`.

| Category | Runs | Semantic passes | Contract-valid / client-usable | Finding |
| --- | ---: | ---: | ---: | --- |
| Simple edits | 8 | 8 | 8 / 8 | Passed |
| Linked changes | 8 | 8 | 8 / 8 | Passed |
| Gameplay logic | 8 | 8 | 8 / 8 | Passed |
| Preservation | 6 | 1 | 6 / 6 | Five protected-object conflicts clarified instead of safely rejecting |
| Ambiguity | 6 | 5 | 6 / 6 | One `ambiguity-the-door` repeat proposed a patch instead of clarifying |
| Unsupported/conflicting | 6 | 6 | 6 / 6 | Passed |
| **Total** | **42** | **36** | **42 / 42** | **Complete, with six semantic failures** |

The rerun cost $0.20417. Combined with prior recorded evaluation spend, the
known total is $0.37900 under the authorized $1.00 ceiling. All returned
candidates were revision-bound and consumable by the current client. A
provider-side hard spend cap remains unverified.

On 2026-09-23 the exact 30-case suite plus two repeats of six representative
cases was sent to `https://levelproof.vercel.app/api/compile`. The raw run is
`/tmp/levelproof-live-evaluation.json`; a corrected-prompt retest is
`/tmp/levelproof-live-followup-logic-goal-before-key.json`.

| Category | Unique cases reaching model | Unique semantic passes after retest | Repeat findings |
| --- | ---: | ---: | --- |
| Simple edits | 6/6 | 6/6 | Add-key repeat 2/2 |
| Linked changes | 6/6 | 6/6 | Atomic key/rule/door removal 2/2 |
| Gameplay logic | 6/6 | 6/6 | Switch-trap repeat 2/2; one original goal-placement wording was rejected as unsupported, then passed after clarifying the prompt and retesting once |
| Preservation | 0/4 | Not evaluated | Both protected-module repeats and all four unique cases were rejected by the deployed request validator before inference |
| Ambiguity | 4/4 | 4/4 | Door-placement base request clarified; one of two repeats invented a brass-key condition (unsafe overreach) |
| Unsupported/conflicting | 4/4 | 4/4 | Jumping repeat 2/2 |

The initial 42-record run produced 36 model responses: all 36 passed the model
result schema and response-envelope checks; 34/36 met the semantic assertion.
The remaining two were the overly temporal goal-placement request and the
door-condition overreach. A single retest of the goal case passed after the
fixed suite prompt was changed from “move the goal ... before the key is
collected” to “Move the goal to the upper foyer.” This avoids asking for an
unsupported sequencing rule that was not necessary to the intended edit. It
does not establish repeat reliability for that corrected case.

The original production-compatibility result was serious: **0/36 successful
responses were consumable by the checkout that ran the suite**, because all 36
carried a different `baseRevision`; protected-id cases were rejected before
inference. The client correctly failed closed; weakening revision or protection
checks would have risked applying stale or unprotected edits and was not done.

On 2026-09-23 a synchronized production build was deployed and two targeted
live follow-ups passed end to end:

| Case | Result | Latency | Cost | Client usability |
| --- | --- | ---: | ---: | --- |
| `simple-add-key` | Patch | 6.685 s | $0.00380 | Usable; matching revision |
| `preserve-protected-module` | Unsupported | 8.312 s | $0.00437 | Usable safe rejection; protected ids accepted |

The latter is the expected outcome for a request that conflicts with a
protected object. It proves the current endpoint accepts and returns a
client-usable protected-id request; it does not establish reliability for all
four preservation cases.

Twenty-seven uncached model requests in the 42-record run took a median 5.82 s
(range 3.04–15.61 s). Nine results were cache hits. The 42-record run reported
$0.13750125, the corrected goal retest $0.0039435, and an earlier partial
attempt before the full run $0.02522: **$0.16666475 known total** before the
synchronized follow-ups. The two follow-ups added $0.00817, for **$0.17483
known total**, below the $0.25 software ceiling. A provider-side hard spending
cap was not verified.
These outcomes measure this deployed model/configuration on this date; they do
not imply other models or future backend revisions behave the same way.

The repeated ambiguous-door overreach is a confirmed historical reliability
defect. The current compile prompt says an unqualified door must remain open,
conditions must never be invented, and materially ambiguous location/behavior
should be clarified. The cache prompt version was bumped and a regression
assertion was added. This is deployed, but the specific ambiguous-door case has
not yet been retested live.

## Fixes made

1. Corrected the deployed reliability battery so ordinary fixture results keep
   their actual category instead of being mislabeled `followup`.
2. Corrected the older direct evaluator to apply rule proposals through
   `applyRuleProposal`, matching the product approval transaction.
3. Added engine-owned `FailureEvidence` so replay highlights, facts, and
   implicated ids are derived from the verifier witness.
4. Revalidate a stored failing route against a repaired level before offering
   “Replay the failing route.”
5. Preserve saved drafts and malformed legacy entries, including lineage and
   storage-failure recovery.
6. Show human-readable before/after operation descriptions and rule changes,
   color-key scene markers, and an added-item floor halo. The preview card now
   scrolls into view, and the sticky verdict strip yields while approval is
   pending so it cannot cover the approval action.
7. Pause the failure replay at the verified decisive move, highlight the
   implicated scene elements, and route “Back to repair” through the existing
   repair preview and approval flow.
8. Add a live runner for the fixed 30-case semantic suite plus two repeats of
   six representatives, with schema, semantics, protection, revision binding,
   latency, cache, and spend reported separately.
9. Default unspecified new doors to open in the current prompt and prohibit
   inferred key/switch conditions; `PROMPT_VERSION` is bumped and a prompt
   regression test guards the instruction.
10. Added shared, atomic Upstash request budgets to both paid endpoints. The
    production guard fails closed on protection failure, accepts stdin-pasted
    credentials with accidental line breaks safely normalized, and has focused
    regression coverage. A live invalid request reaches normal schema
    validation (HTTP 400), proving the guard is active.

## Remaining evidence gaps

- The synchronized live API has two targeted end-to-end passes, not a complete
  rerun of all 30 fixed cases. Earlier results from the pre-synchronized
  deployment remain historical evidence only.
- The no-invented-door-condition instruction has deterministic prompt coverage;
  the specific ambiguous-door prompt still needs a live retest.
- Outside-user testing with three unfamiliar people was not conducted.
- Safari, a real phone, and a lower-powered laptop remain unverified.
- Browser media emulation is not evidence that the operating system’s reduced-
  motion setting was changed.
