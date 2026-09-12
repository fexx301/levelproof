import { useState } from 'react';
import { DisclosureGlyph } from './check-strip.js';
import { EXAMPLE_PROMPTS } from './example-prompts.js';
import { useApp } from '../state/store.js';

/** The prompt panel (§12): describe a change, watch it compile. */
export function PromptPanel() {
  const [text, setText] = useState('');
  const busy = useApp((s) => s.busy);
  const error = useApp((s) => s.error);
  const meta = useApp((s) => s.lastCompileMeta);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const hasKey = useApp((s) => (s.draft?.level ?? s.acceptedLevel).keys.length > 0);

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
          'Put a brass key on the side balcony. Lock the vault with it. The player must collect that key before reaching the treasure.'
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
