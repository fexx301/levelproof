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
