import { useEffect, useState } from 'react';
import type { AdventureIntent } from '../core/adventure.js';
import { continueAdventure, currentChapter, dismissChapterCard } from '../state/adventure.js';
import { useApp } from '../state/store.js';
import { CompileProgressCard } from './prompt-panel.js';

/**
 * Endless verified adventure (§12). After a win the player asks for the next
 * chapter — or just "Surprise me" — and the AI writes a new world from the
 * story so far and how they played. The engine proves it fair before they
 * enter; the title card says so.
 */

const DIRECTIONS: Array<{ label: string; words: string; intent: AdventureIntent }> = [
  { label: 'Surprise me', words: 'Surprise me.', intent: 'steady' },
  { label: 'Harder', words: 'Make the next chapter harder.', intent: 'harder' },
  { label: 'Easier', words: 'Make the next chapter a little easier.', intent: 'easier' },
];

/** Shown on the win card: continue into the next chapter. */
export function AdventureContinue() {
  const adventure = useApp((s) => s.adventure);
  const busy = useApp((s) => s.busy);
  const [where, setWhere] = useState('');
  const [last, setLast] = useState<{ words: string; intent: AdventureIntent } | null>(null);
  const chapter = currentChapter();
  const writing = adventure.writing && busy;
  const go = (words: string, intent: AdventureIntent): void => {
    if (busy) return;
    setLast({ words, intent });
    void continueAdventure(words, intent);
  };
  return (
    <section className="adventure-continue" aria-label="Continue the adventure">
      <p className="adventure-kicker">{chapter !== null ? `Chapter ${chapter.number} complete` : 'Keep going'}</p>
      <h3 className="adventure-title">Continue the adventure</h3>
      {writing ? (
        <CompileProgressCard />
      ) : (
        <>
          <p className="panel-note">
            The AI writes the next chapter from the story so far and how you played; the engine proves it can be won — and that
            nobody can get stuck — before you step in.
          </p>
          <div className="example-prompts" role="group" aria-label="Next chapter">
            {DIRECTIONS.map((direction) => (
              <button key={direction.label} type="button" className="example-chip" onClick={() => go(direction.words, direction.intent)}>
                {direction.label}
              </button>
            ))}
          </div>
          <form
            className="play-react-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (where.trim().length > 0) go(where, 'steady');
            }}
          >
            <input
              className="prompt-input"
              type="text"
              value={where}
              maxLength={300}
              aria-label="Where next?"
              placeholder="Where next? “take me underground”"
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(event) => setWhere(event.target.value)}
            />
            <button type="submit" disabled={where.trim().length === 0}>Go</button>
          </form>
          {adventure.error !== null && (
            <div className="play-react-note play-react-note--error" role="alert">
              {adventure.error}
              {last !== null && (
                <>
                  {' '}
                  <button type="button" className="example-chip" onClick={() => go(last.words, last.intent)}>Try again</button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The chapter in play, above the controls. */
export function AdventureStrip() {
  useApp((s) => s.adventure.chapters);
  useApp((s) => s.acceptedLevel);
  const chapter = currentChapter();
  // An ordinary level becomes "chapter 1" silently; an adventure started from
  // a sentence names its first chapter too.
  if (chapter === null || (chapter.number === 1 && chapter.band === undefined)) return null;
  return (
    <p className="adventure-strip">
      <span>Chapter {chapter.number}</span> · {chapter.title}
    </p>
  );
}

/**
 * The title card when a chapter begins: its name, the story beat, and the
 * engine's proof — the line a player (and a judge) should not miss.
 */
export function ChapterCard() {
  const intro = useApp((s) => s.adventure.intro);
  useEffect(() => {
    if (intro === null) return;
    const timer = window.setTimeout(dismissChapterCard, 9000);
    return () => window.clearTimeout(timer);
  }, [intro]);
  if (intro === null) return null;
  return (
    <button type="button" className="chapter-card" onClick={dismissChapterCard} aria-label={`Chapter ${intro.number}: ${intro.title}. Dismiss`}>
      <span className="chapter-card-number">Chapter {intro.number}</span>
      <span className="chapter-card-title">{intro.title}</span>
      <span className="chapter-card-story">{intro.narration}</span>
      <span className="chapter-card-proof">
        ✓ Verified solvable — all {intro.explored.toLocaleString()} reachable states checked · nobody can get stuck · shortest route {intro.shortest} moves
        {intro.gates > 0 ? ` · ${intro.gates} locked door${intro.gates === 1 ? '' : 's'}` : ''}
      </span>
    </button>
  );
}
