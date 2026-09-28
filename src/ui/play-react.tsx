import { useMemo, useState } from 'react';
import { verify } from '../core/verifier.js';
import { useApp } from '../state/store.js';
import { CompileProgressCard } from './prompt-panel.js';

/**
 * Talk to the world while playing it (§12): the player reacts in words —
 * "too easy", "add a trap here" — and the AI changes the level they are
 * standing in. It is the same compile path as the editor (streamed plan,
 * engine-guided revisions, Keep these, stale-result guards), so the engine
 * checks the change before the player sees it, and the player approves it:
 * "Play the new version" respawns them in the changed world.
 */

interface Reaction {
  label: string;
  prompt: string;
  /** Sends the module the player stands in as the selection ("here"). */
  here?: boolean;
}

export const PLAY_REACTIONS: Reaction[] = [
  {
    label: 'Too easy — make it harder',
    prompt: 'That was too easy. Make this puzzle harder by adding one new key-and-door challenge on the way to the goal. It must stay winnable, and no one may get stuck.',
  },
  {
    label: 'Add a trap here',
    prompt: 'Add a trap at the selected spot where I am standing: a pressure plate there that seals a door somewhere behind me. Place it so the level can still be won.',
    here: true,
  },
  {
    label: 'Add a secret room',
    prompt: 'Add one small secret room with a treasure chest, connected off the existing route. It must be reachable but not required to win.',
  },
  {
    label: 'Make it spookier',
    prompt: 'Make it spookier: night lighting and a few eerie props like dead trees, gravestones, and candles. Do not change the gameplay.',
  },
];

export function PlayReact() {
  const busy = useApp((s) => s.busy);
  const pending = useApp((s) => s.pendingRule);
  const lastResult = useApp((s) => s.lastResult);
  const error = useApp((s) => s.error);
  const at = useApp((s) => s.play.at);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const [text, setText] = useState('');

  const ask = (prompt: string, here = false): void => {
    if (busy || pending !== null || prompt.trim().length === 0) return;
    // "Here" is the player's module, sent the same way a click selects it in the editor.
    useApp.setState({ selection: here && at !== '' ? [at] : [], lastResult: null, error: null });
    void submitPrompt(prompt.trim());
  };

  return (
    <section className="play-react" aria-label="Change this level">
      <h3 className="play-react-title">Change this level</h3>
      {pending !== null ? (
        <PlayProposal />
      ) : busy ? (
        <CompileProgressCard />
      ) : (
        <>
          <div className="example-prompts" role="group" aria-label="Reactions">
            {PLAY_REACTIONS.map((reaction) => (
              <button key={reaction.label} type="button" className="example-chip" onClick={() => ask(reaction.prompt, reaction.here)}>
                {reaction.label}
              </button>
            ))}
          </div>
          <form
            className="play-react-form"
            onSubmit={(event) => {
              event.preventDefault();
              ask(text);
            }}
          >
            <input
              className="prompt-input"
              type="text"
              value={text}
              maxLength={500}
              aria-label="Tell the AI what to change"
              placeholder="Or say it: “add a bridge”"
              // Typing must not steer the character (WASD / arrows / H / R).
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" disabled={text.trim().length === 0}>Ask</button>
          </form>
          {lastResult?.type === 'clarification' && (
            <p className="play-react-note">The AI asks: {lastResult.question}</p>
          )}
          {lastResult?.type === 'unsupported' && (
            <p className="play-react-note">
              Not possible in this kit: {lastResult.reason}
              {lastResult.alternatives.length > 0 && ` Try: ${lastResult.alternatives.join(' · ')}`}
            </p>
          )}
          {error !== null && <p className="play-react-note play-react-note--error">{error}</p>}
        </>
      )}
    </section>
  );
}

/** The engine's verdict on the proposed change, and the player's choice. */
function PlayProposal() {
  const pending = useApp((s) => s.pendingRule)!;
  const applyPatch = useApp((s) => s.applyPatch);
  const approveRule = useApp((s) => s.approveRule);
  const declinePatch = useApp((s) => s.declinePatch);
  const declineRule = useApp((s) => s.declineRule);
  const startPlay = useApp((s) => s.startPlay);
  const report = useMemo(() => verify(pending.candidate), [pending.candidate]);
  const summary = pending.kind === 'patch' ? pending.rationale : pending.proposal.reason;
  const checks: Array<[string, boolean]> = [
    ['Can be won', report.checks.solution.status === 'pass'],
    ['Nobody gets stuck', report.checks.recovery.status !== 'fail'],
    ['Rules hold', report.checks.requirements.status !== 'fail'],
  ];
  const accept = (): void => {
    if (pending.kind === 'patch') applyPatch();
    else approveRule();
    // Applying settles into the editor; the player goes straight back in.
    // Changing a shared puzzle makes it the player's remix (clean URL, their
    // earlier session filed), exactly as leaving the share would.
    if (useApp.getState().pendingRule === null && useApp.getState().error === null) {
      if (useApp.getState().viaShare) useApp.getState().exitToAuthoring();
      startPlay();
    }
  };
  const decline = (): void => {
    if (pending.kind === 'patch') declinePatch();
    else declineRule();
    useApp.setState({ selection: [] });
  };
  return (
    <div className="play-proposal" role="group" aria-label="Proposed change">
      <p className="play-proposal-summary">{summary}</p>
      {pending.kind === 'patch' && pending.revision !== undefined && pending.revision.outcome !== 'unresolved' && (
        <p className="panel-note">The engine found a problem in the AI’s first attempt; the AI revised it.</p>
      )}
      <ul className="play-proposal-checks" aria-label="Engine pre-check">
        {checks.map(([label, ok]) => (
          <li key={label} className={ok ? 'is-pass' : 'is-fail'}>
            {ok ? '✓' : '✗'} {label}
          </li>
        ))}
      </ul>
      <div className="card-actions">
        <button type="button" className="button--play" onClick={accept}>Play the new version</button>
        <button type="button" onClick={decline}>Keep this one</button>
      </div>
    </div>
  );
}
