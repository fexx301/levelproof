# LevelProof demo video (under 3 minutes)

The submission video must stay under three minutes; this plan runs about
2:45. It uses only the real product. Judges will type their own prompts
(terms §9), so the video opens the way they will: one sentence on the
welcome screen. Keep “Fresh compile” / “Cached result” honest, and caption
any wait you trim.

**One line to carry through:** *Most prompt-to-world tools give you a scene
that looks right. LevelProof gives you a world that is proven playable
before you step in.*

## Flow

| Time | On screen | Say (voice-over) | Caption |
|---|---|---|---|
| 0:00–0:10 | The welcome screen, slowly orbiting world. | “AI can build a 3D world from one sentence. Nobody checks that it can actually be played. Which is why LevelProof exists.” | *Describe a world. Play it. The AI keeps writing it.* |
| 0:10–0:30 | Type the prompt (below), press **Start the adventure**. The plan streams in; the chapter flyover lands on the title card. | “One sentence. The model composes rooms, keys, doors and scenery — and before I can step in, a deterministic engine explores every reachable state.” | *Model wait trimmed (≈ 8 s)* · then hold on *✓ Verified solvable — all N states checked · nobody can get stuck* |
| 0:30–0:55 | Walk (WASD) to the merchant. Press **Talk (T)**: the plain line appears at once, then the AI voice. The hint trail lights the floor. | “Characters know the way. The engine works out my next objective from exactly where I stand. The AI only says it in character — and the server refuses a line that skips the objective or names anything that isn’t in the world.” | *The engine decides what’s true. The AI says it.* |
| 0:55–1:10 | Collect the key (it flies into the inventory), the door opens, reach the goal: **Level complete**. | “Key, door, goal — exactly what the engine promised.” | — |
| 1:10–1:30 | Before winning, or on a replay: **Too easy — make it harder**. The preview shows the engine pre-check; **Play the new version** respawns you. | “I can talk to the world while I play it. The AI changes the level I’m standing in — and the engine checks the change before I see it.” | *Engine pre-check: can be won · nobody gets stuck · rules hold* |
| 1:30–1:45 | **Back to editing**, type *“add an enemy that chases you”* → the honest **unsupported** card with alternatives. | “And when I ask for something it can’t simulate, it says so — and offers what it can do.” | *Honest refusal, not a fake* |
| 1:45–2:20 | Scene list → **The Balcony Vault**. **Key + locked door** → apply. **The switch trap** → apply. *Can a player get stuck?* turns **Yes**, floors go red. **Show the problem**: the ghost replays the route and pauses on the decisive move. | “Now I break it on purpose. A switch that seals the gallery behind you. One playthrough would never find this — the engine finds it every time, and shows me the exact route that strands the player.” | *Verified failure — replayed from the real engine* |
| 2:20–2:35 | **Find checked repairs** → preview (old red, new green) → **Apply** → **Replay the failing route**: nobody is stranded now. | “Repairs are checked before I see them, and they never weaken my rules. Same moves — nobody gets stuck.” | *Every repair re-verified* |
| 2:35–2:45 | **Share** → end card: URL and repository. | “LevelProof. The AI proposes. The engine proves. You play.” | *levelproof.vercel.app · github.com/fexx301/levelproof* |

If the cut runs long, drop the 1:30 refusal beat first, then shorten the
repair beat to the replay alone.

## Prompts

- **Record with:** *“A medieval quest hub town with a merchant and a locked
  gate to the wild road.”* In the Oct 24 character battery the closest
  prompt (a quest hub with a merchant) placed a merchant and was accepted on
  the first try — one run, so rehearse it on the deployed site the day you
  record.
- **Backup:** *“A mountain village where a friendly guide shows you the path
  to the shrine.”* (placed a guide, accepted, Oct 24).
- A prompt you rehearsed is cached: it will answer instantly and say
  **Cached result**. Either show that label, or record with an unseen
  variation of the same sentence and keep the rehearsed one as the backup.

## Before recording

1. The current `main` is deployed to production and the example prompts are
   prewarmed (`operations-checklist.md`).
2. A real GPU browser at 1440×900 or larger, sound on (the game has
   synthesized sound), the first-run guide dismissed only after the opening
   shot.
3. Rehearse the whole path once on the deployed site; note where the
   merchant stands so the walk is short.
4. Record in segments (welcome → play → break → repair); join them in the
   edit. Trim model waits, and caption each trim.

## If something fails while recording

- A chapter comes back unfair: the product revises it; keep it if it lands,
  otherwise use the backup prompt.
- The voice is slow or unavailable: the plain line already shows, labeled
  “the engine’s own words”. Keep it; it is honest and still makes the point.
- Model service down: use the gallery scenes (**The Balcony Vault**, **The
  Sentry**) and say on screen that the generation step is not shown live.

## Claims to avoid

- Do not call a cached or fixture result a fresh AI result.
- Do not say a character or any scenery does anything in play: characters
  only talk; the dragon never blocks.
- Do not claim VR, multiplayer, accounts, cloud saves, or arbitrary meshes.
- Do not claim Safari or real-phone support beyond what was tested.
- Do not say one winning playthrough proves a level can’t trap the player.
