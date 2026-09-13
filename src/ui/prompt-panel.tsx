import { useState } from 'react';
import { DisclosureGlyph } from './check-strip.js';
import { EXAMPLE_PROMPTS, TWIST_PROMPT } from './example-prompts.js';
import { useApp } from '../state/store.js';

/** The prompt panel (§12): describe a change, watch it compile. */
export function PromptPanel() {
  const [text, setText] = useState('');
  const busy = useApp((s) => s.busy);
  const error = useApp((s) => s.error);
  const meta = useApp((s) => s.lastCompileMeta);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const hasKey = useApp((s) => (s.draft?.level ?? s.acceptedLevel).keys.length > 0);
  const changeSummary = useApp((s) => s.changeSummary);
  const history = useApp((s) => s.history);
  const loadSceneLevel = useApp((s) => s.loadLevel);
  const selection = useApp((s) => s.selection);
  const clearSelection = useApp((s) => s.clearSelection);
  const protectedIds = useApp((s) => s.protectedIds);
  const keepSelected = useApp((s) => s.keepSelected);
  const unkeep = useApp((s) => s.unkeep);

  const submit = () => {
    void submitPrompt(text);
  };

  // One-click examples: the cache-verified canonical demo prompts, so a
  // first-time visitor can reach the signature moment without reading docs.
  const examples: { label: string; prompt: string }[] = [
    { label: 'Key + locked door', prompt: EXAMPLE_PROMPTS.baseline },
    {
      label: 'The switch trap',
      // Self-sufficient on a fresh scene; the canonical second step once the
      // baseline (any key) is already in place.
      prompt: hasKey ? EXAMPLE_PROMPTS.trap : EXAMPLE_PROMPTS.trapOneShot,
    },
    { label: 'Remove the ramp', prompt: EXAMPLE_PROMPTS.removeRamp },
    { label: 'Suggest a twist', prompt: TWIST_PROMPT },
  ];
  const runExample = (prompt: string) => {
    setText(prompt);
    void submitPrompt(prompt);
  };


  return (
    <section className="prompt-panel" aria-label="Describe a change">
      <label className="prompt-label" htmlFor="prompt-input">
        Describe a change
      </label>
      <textarea
        id="prompt-input"
        className="prompt-input"
        value={text}
        maxLength={2000}
        rows={3}
        placeholder={
          'Click a floor, key, switch, or door in the scene to select it — then describe the change. Or: put a brass key on the side balcony and lock the vault with it.'
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      <div className="prompt-actions">
        <button
          type="button"
          className="prompt-submit"
          disabled={busy || text.trim().length === 0}
          onClick={submit}
        >
          {busy ? 'Compiling…' : 'Compile'}
        </button>
        <span
          className={`compile-status${meta?.cached ? ' is-cached' : ''}`}
          aria-live="polite"
        >
          {meta ? (meta.cached ? 'Cached compile' : 'Fresh compile') : ''}
        </span>
      </div>
      {selection.length > 0 && (
        <div className="selection-row" role="group" aria-label="Selected scene entities">
          <span className="panel-note">Selected:</span>
          {selection.map((id) => (
            <button
              key={id}
              type="button"
              className="example-chip"
              onClick={() => useApp.getState().toggleSelect(id)}
            >
              {id} ✕
            </button>
          ))}
          <button type="button" className="example-chip" onClick={keepSelected}>
            Keep these
          </button>
          <button type="button" className="example-chip" onClick={clearSelection}>
            Clear
          </button>
        </div>
      )}
      {protectedIds.length > 0 && (
        <div className="selection-row" role="group" aria-label="Kept entities">
          <span className="panel-note">Kept:</span>
          {protectedIds.map((id) => (
            <button key={id} type="button" className="example-chip example-chip--kept" onClick={() => unkeep(id)}>
              {id} ✕
            </button>
          ))}
        </div>
      )}
      <div className="example-prompts" role="group" aria-label="Example prompts">
        <span className="panel-note">Try:</span>
        {examples.map((example) => (
          <button
            key={example.label}
            type="button"
            className="example-chip"
            disabled={busy}
            onClick={() => runExample(example.prompt)}
          >
            {example.label}
          </button>
        ))}
      </div>
      {changeSummary !== null && (
        <p className="change-summary" aria-live="polite">
          Changed: {changeSummary}
        </p>
      )}
      <p className="panel-note">
        {typeof navigator !== 'undefined' &&
        /Mac|iP/.test(
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ?? navigator.platform,
        )
          ? '⌘⏎'
          : 'Ctrl+⏎'}{' '}
        compiles
      </p>
      {history.length > 0 && (
        <details className="inspector">
          <summary><DisclosureGlyph />History</summary>
          <ol className="history-list">
            {history.map((entry, index) => (
              <li key={index}>
                <button type="button" className="history-entry" onClick={() => loadSceneLevel(entry.level)}>
                  {entry.label}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {meta && !meta.cached && (
        <details className="inspector">
          <summary><DisclosureGlyph />Model</summary>
          <p className="inspector-body">
            {meta.model} · ${meta.totalCostUsd.toFixed(5)} · {meta.attempts} attempt
            {meta.attempts === 1 ? '' : 's'}
          </p>
        </details>
      )}
      {error && (
        <p className="compile-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
