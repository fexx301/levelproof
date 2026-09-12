import { useState } from 'react';
import { useApp } from '../state/store';

/** The prompt panel (§12): describe a change, watch it compile. */
export function PromptPanel() {
  const [text, setText] = useState('');
  const busy = useApp((s) => s.busy);
  const error = useApp((s) => s.error);
  const meta = useApp((s) => s.lastCompileMeta);
  const submitPrompt = useApp((s) => s.submitPrompt);

  const submit = () => {
    void submitPrompt(text);
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
        {meta && (
          <span className={`compile-status${meta.cached ? ' is-cached' : ''}`}>
            {meta.cached
              ? 'Cached compilation'
              : `Live · ${meta.model} · $${meta.totalCostUsd.toFixed(5)} · ${meta.attempts} attempt${
                  meta.attempts === 1 ? '' : 's'
                }`}
          </span>
        )}
      </div>
      {error && (
        <p className="compile-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
