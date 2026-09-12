# LevelProof — submission description

**Category framing:** AI copilot for 3D creation (browser-based editor).

**What we built.** LevelProof is an AI puzzle creator with automatic
playtesting. You describe a small 3D puzzle in plain language — "put the brass
key on the balcony and make the vault door require it" — and a live language
model compiles your intent into typed operations on a discrete kit (floors,
ramps, bridges, keys, one-shot switches, doors). A deterministic playtester
then exhaustively explores every reachable state of the resulting scene and
reports three independent verdicts: does a solution exist, does *every*
winning route honor your design requirements, and can every reachable state
still recover? When something breaks, you don't get a warning label — you get
the failure itself: a ghost pawn replays the exact doomed route (the keyless
bypass, the player who seals a door behind themselves), and a repair search
offers checked fixes that provably preserve your rules. You can then play the
scene yourself with the same movement engine the checker used.

**The problem we explored.** Generative tools are good at producing scenes and
bad at guaranteeing they *work*. One successful playthrough proves nothing
about dead ends or shortcuts — and nobody can playtest every branch of a
puzzle by hand. LevelProof makes verification the product: the AI proposes,
deterministic search disposes, and the human approves.

**How AI is used.** The model composes typed edits against an authoritative
scene summary — it can never emit raw scene JSON, traversal edges, or
verdicts; those come only from the shared core engine that the player, the
ghost, and the verifier all call. Ambiguous requests return a clarifying
question, unsupported ones an honest refusal. Compile results are cached with
full disclosure (fresh vs. cached, model, cost, attempts), and rule changes
require explicit human approval — the system cannot weaken your design
requirements on its own.
