import { useState } from 'react';
import { startAdventure } from '../state/adventure.js';
import { dismissLanding, useApp } from '../state/store.js';
import { BUILD_PROMPTS } from './example-prompts.js';
import { CompileProgressCard } from './prompt-panel.js';

/**
 * The first-visit welcome (§12): one sentence starts an adventure. Chapter 1
 * is written by the AI and proven fair by the engine before the player
 * steps in; winning it offers the next chapter. The editor is one click away.
 */
export function Landing() {
  const landing = useApp((s) => s.landing);
  const busy = useApp((s) => s.busy);
  const writing = useApp((s) => s.adventure.writing);
  const error = useApp((s) => s.adventure.error);
  const [words, setWords] = useState('');
  if (!landing) return null;
  const start = (sentence: string): void => {
    if (busy || sentence.trim().length === 0) return;
    void startAdventure(sentence);
  };
  return (
    <div className="landing" role="dialog" aria-modal="true" aria-labelledby="landing-title">
      <div className="landing-card">
        <p className="landing-brand">LevelProof</p>
        <h1 id="landing-title" className="landing-title">Describe a world. Play it. The AI keeps writing it.</h1>
        <p className="landing-lede">
          Every chapter is a 3D puzzle the engine has already proven can be won — every reachable position checked — before you
          step in.
        </p>
        {writing && busy ? (
          <div className="landing-writing">
            <p className="landing-writing-title">Writing chapter 1…</p>
            <CompileProgressCard />
          </div>
        ) : (
          <>
            <form
              className="landing-form"
              onSubmit={(event) => {
                event.preventDefault();
                start(words);
              }}
            >
              <input
                className="prompt-input landing-input"
                type="text"
                value={words}
                maxLength={500}
                autoFocus
                aria-label="Describe a world"
                placeholder="A lighthouse on a stormy island, the key in the keeper’s cottage…"
                onChange={(event) => setWords(event.target.value)}
              />
              <button type="submit" className="button--play landing-start" disabled={words.trim().length === 0}>
                Start the adventure
              </button>
            </form>
            <div className="landing-examples" role="group" aria-label="Example worlds">
              <span className="panel-note">Or try</span>
              {BUILD_PROMPTS.map((build) => (
                <button key={build.label} type="button" className="example-chip" onClick={() => start(build.prompt)}>
                  {build.label}
                </button>
              ))}
            </div>
            {error !== null && (
              <p className="play-react-note play-react-note--error" role="alert">
                {error}
              </p>
            )}
            <ol className="landing-steps">
              <li>
                <strong>Describe</strong> one sentence becomes a playable world
              </li>
              <li>
                <strong>Play</strong> the engine has already checked it can be won
              </li>
              <li>
                <strong>Keep going</strong> win, and the AI writes the next chapter around how you played
              </li>
            </ol>
            <button type="button" className="landing-editor" onClick={dismissLanding}>
              Explore the editor instead →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
