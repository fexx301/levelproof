# Creator session script (§14 gate, §17 evidence)

Three sessions with real creators, each ~30 minutes. The goal is not to demo
— it is to watch someone build their own puzzle without the vault script and
record where the product helps or fails them. Record (with permission) or
take timestamped notes; both the hesitations and the surprises are the
findings.

## Before the session

- Fresh browser profile or incognito, production URL
  (<https://levelproof.vercel.app>) — no cached state, no saved puzzles.
- Screen recording on. Ask permission to record.
- Do not open the app yourself. The creator drives from the first click.

## The script

**1. Warm-up (2 min).** "This is a tool for making small 3D puzzles with AI.
Don't explain it further — watch what they understand from the page alone.
Note anything they ask that the UI should have answered.

**2. Free build (10 min).** "Make any small puzzle you like. You can type
what you want, or click things in the scene and describe the change." Let
them pick any scene, including Blank canvas. Do not suggest prompts. Note:

- What they type first, and whether the result matches their intent.
- Whether they discover selection, the scene picker, the example chips.
- Any moment they look confused, retry, or rephrase.

**3. Break it on purpose (5 min).** "Now change your puzzle in a way you
think might break it." Note whether they predict the failure the checker
finds — and especially whether **the checker catches something they did not
expect**. That moment is the product's thesis; capture it verbatim.

**4. Read the failure (5 min).** "Show me what went wrong." Watch whether
they use the red floors, the ghost, the explanation button, or the check
text — in what order, and what actually lands. Ask at the end: "In your own
words, why did it fail?"

**5. Choose a repair (5 min).** "Fix it, but keep whatever matters to you."
Watch whether they preview, keep entities, compare candidates, and whether
the applied fix matches their intent. If they replay the failing route, note
whether the "same moves, no longer fatal" reading is clear.

**6. Share (3 min).** "Send this puzzle to a friend." Do they find Save /
Share? Does the play-mode link make sense to them?

## What we are measuring

- Time to first accepted puzzle; time to first intentional break.
- Every hesitation or rephrase (quote it).
- Every case where the checker's verdict surprised the creator (gold).
- Every case where the compile result did not match their intent (bug or
  prompt gap — file it with the exact prompt text).
- Whether the checks' language ("check incomplete", "not applicable") reads
  honestly or confusingly.

## After each session

Within 24 hours: write up findings in `DECISIONS.md` under the session date —
quotes, timings, surprises, and any prompt or UI fix that follows. The three
sessions together are §17 evidence; one authentic clip of a creator
discovering an unintended shortcut in their own puzzle is the strongest
submission material the sessions can produce.
