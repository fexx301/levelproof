# LevelProof two-minute demonstration

This script uses only the product’s real workflow. Judges will type their own
prompts (terms §9), so the video opens the way they will: with a world typed
from scratch. If a model response is not available, label the seeded
scene/ghost playback as a deterministic backup; do not present it as live
generation. Keep “Fresh compile” / “Cached result” visible when it appears.

## Primary run (≈ 2 min)

1. **0:00 — Type a world.** Choose **Blank canvas**. Type a sentence the
   audience has never seen, e.g. *“Build a sunken desert tomb: a sandstone
   stair down into the tomb, a golden scroll that opens the pharaoh’s chamber,
   palm trees and a campfire at the entrance.”* Press **Build it**.
2. **0:10 — Watch it stream.** Point at the live card: the model’s own plan
   headlines, then each operation as it is written. Say: “Nothing is applied
   yet — the engine checks the finished proposal first.”
3. **0:25 — The proposal.** The viewport shows the world it would create
   (badge: *Preview — not applied yet*). Read the one-line summary and the
   **engine pre-check**. Point out the scenery disclaimer: palms and campfire
   are decoration; the scroll-shaped key is the real mechanic. **Apply edit**.
4. **0:40 — Play it.** **Play the level**, take a few steps with the keys,
   collect the scroll (it vanishes into the inventory), open the door.
   **Back to editing (Esc)**.
5. **0:55 — Break it on purpose.** Switch to **The Balcony Vault**. Press
   **Key + locked door**, apply, then **The switch trap**, apply. *Can a player
   get stuck?* turns to **Yes**; red floors appear.
6. **1:10 — See the failure.** **Show the problem**: the ghost walks the
   verified route and pauses on the decisive move; the evidence card names the
   switch and the sealed door. Optionally **Why did this fail?**
7. **1:30 — Repair without losing the idea.** **Back to repair** →
   **Find checked repairs** → preview the switch relocation (old position red,
   new green) → **Apply**. **Replay the failing route**: the same moves no
   longer strand anyone. (Alternative: **Ask the AI to fix it** and show the
   engine pre-check on its proposal.)
8. **1:50 — Keep it.** **Save checkpoint**, **Share**; say the link opens the
   accepted puzzle in play mode, never an unapproved draft.

## Optional beats if time allows

- **The AI and the engine argue.** A blank-canvas build that comes back
  unwinnable shows *Engine found: The level cannot be won…* in the progress
  card, then a preview that says it was revised once. This is live behavior;
  do not stage it with a fixture in the video.
- **Spooky night makeover** on any gallery scene: the world changes, the
  engine checks stay identical.

## Before recording

- Deploy and prewarm (see `operations-checklist.md`); confirm the chips answer
  “Cached result” and the blank-canvas prompt you plan to type is fresh.
- Use a real GPU browser window at 1440×900 or larger.
- Dismiss the first-run guide unless you want to show it.

## Backup demonstration

Use the seeded gallery scenes and their verifier ghost replays to show that the
checker is deterministic. Label this as a seeded/deterministic demonstration;
it does not prove live model behavior.

## Claims to avoid

- Do not call a fixture or cached result a fresh AI result.
- Do not claim that scenery does anything in play (the dragon never blocks).
- Do not claim accounts, cloud saves, multiplayer, or arbitrary mesh modeling.
- Do not claim Safari or real-device support without running those devices.
- Do not claim that a single winning route proves recovery.
