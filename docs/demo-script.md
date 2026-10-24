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
| 0:55–1:15 | Before winning: **Too easy — make it harder**. The proposal shows the engine pre-check (and, if the AI's change could not be won, the engine's disclosed repair); **Play the new version** respawns you. | “I can talk to the world while I play it. The AI changes the level I’m standing in — and the engine checks the change before I see it.” | *Engine pre-check: can be won · nobody gets stuck · rules hold* |
| 1:15–1:30 | Follow the route: the key flies into the inventory, the door opens, **Level complete**. | “Key, door, goal — exactly what the engine promised.” | — |
| 1:30–1:45 | In the editor, type *“add an enemy that chases you”* → the honest **unsupported** card with alternatives. | “And when I ask for something it can’t simulate, it says so — and offers what it can do.” | *Honest refusal, not a fake* |
| 1:45–2:20 | **The Balcony Vault** → **The switch trap** → **Apply edit**. *Can a player get stuck?* turns **Yes**, floors go red. **Show the problem**: the ghost replays the route and pauses on the decisive move. | “Now I break it on purpose. A switch that seals the gallery behind you. One playthrough would never find this — the engine finds it every time, and shows me the exact route that strands the player.” | *Verified failure — replayed from the real engine* |
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

## Producing it with HyperFrames

The video is assembled by Claude with the HyperFrames skill, from footage of
the live app. HyperFrames supplies everything *around* the product — titles,
captions, transitions, zooms on real footage, the end card — never the
product itself.

**1. Capture the footage (on a Mac with a real GPU, after the latest deploy):**

```bash
npx playwright install chromium          # once
npx tsx scripts/capture-demo.ts --confirm-live-ai --budget-usd 0.10
```

It opens a browser window and plays three takes on the live site: **A** the
welcome sentence → title card → a character → “Too easy” → the win; **B** the
honest refusal; **C** the switch trap → ghost replay → checked repair →
replay → Share. It writes to `demo-footage/` (never committed or deployed):
one `.webm` per take, a full-resolution still per beat in `stills/`, and
`marks.json` with each beat's time in its take. Spend is mostly cached ($0);
the welcome sentence, the character's voice, and the refusal may be fresh
calls (a few cents). Re-run a take with `--only A` (or `B`, `C`), or try
another sentence with `--prompt "…"`. If the recording looks soft, record
the same beats by hand with ⌘⇧5 at 1440×900 and keep the script's stills.

**2. Edit (the HyperFrames session):** build the timeline from `marks.json`,
one row per beat, in the order of the Flow table above:

| Flow time | Take | From beat → to beat | Caption |
|---|---|---|---|
| 0:00–0:10 | A | `welcome` → `prompt-typed` | Describe a world. Play it. The AI keeps writing it. |
| 0:10–0:30 | A | `prompt-typed` → `title-card-proof` (trim the wait) | Model wait trimmed (≈ N s) · ✓ Verified solvable |
| 0:30–0:55 | A | `beside-character` → `character-voice` | The engine decides what's true. The AI says it. |
| 0:55–1:15 | A | `character-voice` → `respawned` | Engine pre-check: can be won · nobody gets stuck · rules hold |
| 1:15–1:30 | A | `respawned` → `level-complete` (speed up the walk) | — |
| 1:30–1:45 | B | `editor` → `honest-refusal` | Honest refusal, not a fake |
| 1:45–2:20 | C | `balcony-vault` → `ghost-decisive-move` | Verified failure — replayed from the real engine |
| 2:20–2:35 | C | `ghost-decisive-move` → `nobody-stranded` | Every repair re-verified |
| 2:35–2:45 | C + end card | `shared` → end card | levelproof.vercel.app · github.com/fexx301/levelproof |

Rules for the edit — none of these are optional:

- **Real footage only** for anything inside the app. Never recreate, redraw,
  or retype LevelProof's interface, and never change text the app shows.
- **Keep the app's own labels readable**: *Cached result* / *Fresh compile*,
  the engine pre-check, the repair disclosure, *the engine's own words*.
  Captions go where they do not cover them.
- **Trimmed waits are captioned** with the real wait (from the take's
  timings); a sped-up walk is labeled *2× speed*.
- **Under 3:00 including the end card** (aim for 2:45). Export 1920×1080
  H.264 MP4: scale the 1440×900 footage to 1080 high and centre it.
- **Voice-over**: the Flow table's lines. If the voice is synthesized, say so
  in the credits.
- **Credit line** (end card, and add to `docs/submission-description.md`):
  *Video assembled with Claude using HyperFrames from screen recordings of
  the live app.* — plus the voice's source if it is AI-generated (Terms §7).

## Claims to avoid

- Do not call a cached or fixture result a fresh AI result.
- Do not say a character or any scenery does anything in play: characters
  only talk; the dragon never blocks.
- Do not claim VR, multiplayer, accounts, cloud saves, or arbitrary meshes.
- Do not claim Safari or real-phone support beyond what was tested.
- Do not say one winning playthrough proves a level can’t trap the player.
