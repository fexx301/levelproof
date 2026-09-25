# First-use usability notes

## Walkthrough result

The current first-use path now exposes a small **Describe → test → repair**
guide. It distinguishes staged proposals from approved edits, marks draft
state explicitly, and offers a clearly labeled sample request that uses the
real compile endpoint.

The guide is dismissible and stores only its dismissal flag. It does not alter
the level or replace the model response with a hidden canned scene.

## Outside-user status

No unfamiliar outside tester was available for this implementation pass.
The following are hypotheses, not completed acceptance evidence:

- The phrase **Apply edit** should be clearer than a generic save action.
- The **Draft — not accepted** badge and **Return to accepted** action should
  make recovery understandable.
- **Show the problem** should make the verifier/replay relationship discoverable
  without requiring the creator to read the inspector.
- The first likely hesitation is whether **Play the draft** is safe; the UI
  should continue to say that the accepted checkpoint remains intact.

## Three-person, no-coaching study protocol

Run this with three people who have not seen LevelProof. Use a fresh browser
profile and the current production build; do not explain the interface or
point out controls. If live AI is unavailable, use a clearly disclosed
deterministic demo and record that limitation.

Give each participant this single task:

> Make a meaningful change to the puzzle, decide whether it works, and leave
> the level in a state you would be comfortable sharing.

Observe without coaching for up to ten minutes. Record whether they:

1. Distinguish the proposed preview from a committed change and can identify
   what changed before approving.
2. Start a replay or playtest without prompting.
3. Explain the failure in their own words after seeing the decisive replay.
4. Find a repair, inspect its preview, and apply it without losing the accepted
   checkpoint.
5. Save or share the final accepted state, and accurately describe what the
   share contains.

For each participant record: device/browser/viewport, elapsed time to first
compile, hesitation points, incorrect actions, whether each outcome above was
completed unaided, the participant's explanation of **Draft** and **Accepted**,
and one verbatim point of confusion. Do not count moderator hints as success.
After all three, fix repeated blockers before adding new onboarding.

Status: **not conducted**. This requires three real participants; scripted
browser automation and model-generated personas are not substitutes.
