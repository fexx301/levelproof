# LevelProof — submission description

**Focus category:** Browser-native creative tools (use the exact wording from
the submission form; AI-generated 3D scenes is the closest alternative).

**What we built.** LevelProof turns one sentence into a playable 3D puzzle
world — and then proves whether it works. Describe “a haunted forest keep
with the key at the top of a tower and a dragon guarding the treasure room”
and a live model compiles your words into typed operations: rooms, ramps,
bridges, keys, one-shot switches, and doors, plus the scenery that makes it
look like what you said (a night forest, a dragon statue, a torch instead of a
key). You watch the model’s plan and each operation stream in. Before you
accept anything, a deterministic playtester explores every reachable state
and answers three questions: *Can it be won? Does it follow your rules? Can a
player get stuck?*

**The problem we explored.** Generative tools are good at producing scenes
and bad at guaranteeing they *work*. One successful playthrough proves
nothing about dead ends or shortcuts, and nobody can playtest every branch by
hand. LevelProof makes verification the product: the AI proposes, the engine
disposes, and the human approves.

**How AI is used.** The model composes typed edits against an authoritative
scene summary — it never emits raw scene JSON, traversal edges, or verdicts;
those come only from one shared engine used by the player, the ghost, the
verifier, and the repair search. When a build cannot be won, the engine’s
concrete findings go back to the model and it revises (disclosed in the
preview). When a design fails, a ghost replays the exact verified route, the
model narrates the engine’s facts (grounding-checked), and you choose between
an AI fix judged by the engine and deterministic repairs that provably keep
your rules. Ambiguous requests get one clarifying question; mechanics the kit
cannot simulate get an honest “unsupported” with alternatives. Every compile
discloses fresh vs cached, model, cost, and attempts.

**Built with:** Three.js (all 3D procedural except the animated character,
Quaternius' CC0 “Characters Matt”; no AI-generated assets), React, Zustand,
Zod, Vite, Vercel serverless, OpenRouter (`gemini-3.8-flash`).
