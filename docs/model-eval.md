# Model evaluation

Protocol per §10.1: one fixture set — 3 golden prompts, 4 paraphrases, 2
ambiguity cases, 2 unsupported requests, 1 rule-weakening attempt — each
model × 12 fixtures × 2 runs, uncached (no cache exists yet; calls go
straight to the provider), temperature 0, at most one schema-correction
retry, 90 s call ceiling. Grading is deterministic: the model's operations
are applied to the fixture's base level through the real `applyOperations`
and the result is checked with the real `verify` — semantic correctness
means the edit applies and produces the spec-expected check outcomes
(e.g. prompt 2 must surface the recovery failure). Prices verified
2026-09-11 from `openrouter.ai/api/v1/models`.

## Configuration history (disclosed)

- **v1 (defective, runs 1–2):** flat nullable wire envelope and a prompt
  that never showed the `type` field explicitly. Schema-less models omitted
  `type`; schema-enforced models filled wrong-type fields. Run 1 also used
  default reasoning effort with a 30 s ceiling (gpt-oss-120b timed out
  13/24 — its real latency was masked, not measured).
- **v2 (recorded):** per-type `anyOf` wire envelope, an explicit
  response-format contract, reasoning effort low, and one added sentence
  clarifying mixed geometry-plus-requirement requests. Numbers below are
  the final configuration per model; gpt-oss-120b, deepseek-v4-flash,
  deepseek-v3.2, and gemini-3.7-flash were not re-run after the final
  sentence (budget ceiling) — their rows are v2-without-that-sentence.

Per-model request configuration: strict `json_schema` for OpenAI-compatible
and DeepSeek/Qwen models; **no response_format for Gemini** (Google's
structured output rejects our vocabulary: "constraint that has too many
states") — markdown fences are stripped before strict Zod validation.

## Results (24 calls per model, final configuration)

| Model | Schema 1st try | Semantic 1st try | Semantic final | Ambiguity (4) | Rule protection (2) | References clean | Median latency | Cost |
|---|---|---|---|---|---|---|---|---|
| openai/gpt-oss-120b | 22/24 | 12/24 | 12/24 | 2/4 | 2/2 | 10/12 | 3.4 s | $0.0098 |
| deepseek/deepseek-v4-flash | 18/24 | 5/24 | 5/24 | 0/4 | 1/2 | 8/17 | 19.8 s | $0.0096 |
| **google/gemini-2.5-flash-lite** | 16/24 | 10/24 | **16/24** | **4/4** | **2/2** | 8/14 | **1.5 s** | **$0.0069** |
| deepseek/deepseek-v3.2 | 20/24 | 9/24 | 9/24 | 1/4 | 2/2 | 10/14 | 55.0 s | $0.0346 |
| qwen/qwen-plus | 21/24 | 10/24 | 10/24 | 3/4 | 2/2 | 13/18 | 3.9 s | $0.0088 |
| google/gemini-3.7-flash | 16/24 | 12/24 | 16/24 | 2/4 | 2/2 | **16/16** | 7.5 s | $0.1100 |

Failure classes observed: routing a new bridge through occupied cells
(near-universal; gemini-3.7-flash is the only consistent exception); channel
selection on mixed requests; placeholder and label leakage at the
flash-lite class (`"some-switch-id"`, `"upper-gallery"` used as an id);
deepseek-v3.2's 55 s median latency is disqualifying regardless of quality.

## Finding

**No tested model reaches the §10.1 bar** (100% on ambiguity and
rule-protection cases AND ≥ 90% first-try semantic correctness). Best
first-try semantic is 50%; best final is 67%. Per §10.1 this is recorded
rather than a winner forced — invalid output is never accepted to hit a
target.

## Decision

**Primary: `google/gemini-2.5-flash-lite`. Fallback: `google/gemini-3.7-flash`**
(the evaluated fallback inside §10's three-attempt bound).

Rationale: flash-lite is the only model passing both absolute safety gates
(4/4 ambiguity, 2/2 rule-protection) while matching the best final semantic
rate (16/24), at the lowest latency (1.5 s median — demo-viable) and cost
(~$0.0003/call; the $4.50 lifetime ceiling becomes non-binding). Its
failure classes — spatial placement and placeholder ids — are precisely
gemini-3.7-flash's strengths (16/16 references, the only model that
consistently solves bridge geometry). A fumbled primary is rejected
atomically by the deterministic validator and falls to the fallback without
ever risking scene corruption; the retry path measurably works (flash-lite:
10/24 first-try → 16/24 after its allowed retry).

**Budget:** total live-evaluation spend **$0.225 of the $0.25 cap**,
including both defective-configuration runs and all diagnostics recorded
above.

## Sep 12 update — reliability battery and model flip

A 30–34-phrasing battery run through the deployed API (`scripts/reliability.ts`,
engine-graded) replaced the earlier slate's snapshot judgment:

- `google/gemini-2.5-flash-lite` (then-primary, prompt-4/5/6 incl. occupancy
  grid): trap ~4/11 fresh, bypass 0/5 across three runs — bridges on occupied
  cells and label-derived ids are capability failures, not prompt failures.
- `google/gemini-3.7-flash` (new primary): trap 10/11, bypass 3/4 real
  responses, compound 2/2, edits/unsupported/rule-weakening clean — **~93%
  valid on non-outage responses** at ~$0.005 per fresh compile.

Decision: **3.7-flash primary, 2.5-flash-lite fallback** (config live since
Sep 12). Canonical demo strings re-verified fresh under the new model.
Battery spend $0.249 total (raised eval allowance, user-approved).

## Sep 25 update — gemini-3.8-flash at low reasoning effort

Context: the scenery vocabulary made the system prompt longer (prompt-9 → 11),
and judges will type their own one-sentence worlds. On `gemini-3.7-flash` a
from-scratch build spent 2,000–4,000 reasoning tokens (20–35 s); one swamp
prompt ran past the 45 s attempt timeout. Reasoning is mandatory on these
endpoints (`enabled: false` is rejected) and `reasoning.max_tokens` is not
honored (a 1,024 cap produced 3,866 reasoning tokens); `effort: "low"` is the
lever that works. All runs below are small samples, dated 2026-09-25.

| Run | Prompt | Model | Result |
|---|---|---|---|
| `scripts/eval.ts`, 12 fixtures × 2 (+3 golden repeats) | prompt-9 | `gemini-3.8-flash`, effort low | schema 27/27 · semantic first try **26/27** · ambiguity 4/4 · rule protection 2/2 · references 19/19 · median **4.7 s** · $0.147 |
| 8 one-sentence worlds, blank canvas (`scripts/build-battery.ts`) | prompt-9 | `gemini-3.8-flash`, effort low | valid first try **8/8** · winnable 7/8 · 5.2–11.3 s · ~$0.007 each |
| same 8 worlds | prompt-9 | `gemini-3.7-flash`, default | valid first try 6/8 (one two-items-per-module rejection, one schema error) · 20.3–33.4 s · ~$0.018 each |
| Fixed 30-case suite + 12 repeats via the endpoint (`eval:fixed:live`, local dev API) | prompt-10 | `gemini-3.8-flash`, effort low | **41/42** semantic; the miss changed a door the case marks must-not-change · $0.211 |
| Every example chip × 2, graded (`scripts/chip-battery.ts`) | prompt-11 | `gemini-3.8-flash`, effort low | **24/24**; an earlier run needed one engine-guided revision (Pirate cove) and passed |
| Blank-canvas build chips × 1 | prompt-12 (only omits empty scenery keys from the scene summary) | `gemini-3.8-flash`, effort low | **4/4**, 6.0–16.2 s |

Observations that shaped the prompt and chips:

- Latency follows how much the model deliberates, not how big the build is.
  “make the vault door require it” reasoned for 3,000–5,000 tokens (up to
  38 s) because the edge is ambiguous; naming the edge (“a vault door between
  the vault approach and the vault entry”) produced 0 reasoning tokens and
  ~4 s. The canonical chips now name their edges.
- The prompt-9 preservation misses (clarifying instead of refusing a change
  to a kept object) came from the service instruction itself (“ask the creator
  to unkeep”); prompt-10 asks for an `unsupported` answer naming the kept
  object, and the preservation category went from 3/6 to 6/6.
- Gemini occasionally returns an empty completion after reasoning; the
  service now treats that as invalid output and retries the primary instead of
  dropping to the weaker fallback.
- A generic “add a shortcut” chip was ambiguous on scenes other than the
  vault (a clarification once, a timeout once) and was replaced by a scenery
  makeover chip that is safe on every scene.

Decision: **primary `google/gemini-3.8-flash` (reasoning effort low),
fallback `google/gemini-2.5-flash-lite`**. Deployment requires setting
`LLM_MODEL` and `LLM_FALLBACK_MODEL` in the hosting environment together with
the code (the prompt-11 code on the old 3.7 configuration is slower than
today's production). Spend for this whole improvement pass, every live call
including probes, recordings, and a local prewarm test: about $1.8 (OpenRouter
reported costs).
