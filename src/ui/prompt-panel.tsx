import { useEffect, useState } from 'react';
import { DisclosureGlyph } from './check-strip.js';
import { BUILD_PROMPTS, EXAMPLE_PROMPTS, MAKEOVER_PROMPT, TWIST_PROMPT, WINTER_PROMPT } from './example-prompts.js';
import { useApp } from '../state/store.js';
import { themeKeySchema, type ThemeKey } from '../../shared/api.js';

const THEME_LABELS: Record<ThemeKey, string> = {
  limestone: 'Limestone ruin',
  ivory: 'Ivory observatory',
  patina: 'Patina relay works',
  basalt: 'Basalt lockhouse',
  futuristic: 'Futuristic vault',
};

function costText(costUsd: number | null): string {
  return costUsd === null ? 'cost unavailable' : `$${costUsd.toFixed(5)}`;
}

function stageText(progress: NonNullable<ReturnType<typeof useApp.getState>['compileProgress']>): string {
  if (progress.stage === 'sending') return progress.revising ? 'Sending the engine’s findings to the model…' : 'Sending your request…';
  if (progress.stage === 'thinking') return progress.revising ? 'The model is revising against the engine’s findings' : 'The model is planning';
  if (progress.stage === 'writing') return `Writing the edit — ${progress.operations} operation${progress.operations === 1 ? '' : 's'} so far`;
  if (progress.stage === 'checking') return 'The engine is checking the result';
  if (progress.stage === 'retrying') return 'Retrying';
  return 'Revising';
}

/**
 * Live compile progress: the model's own reasoning headlines and each
 * operation as it streams in. Everything shown is provisional until the
 * finished result passes strict parsing and the engine.
 */
function CompileProgressCard() {
  const progress = useApp((s) => s.compileProgress);
  const cancel = useApp((s) => s.cancelCompile);
  const active = progress !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  if (progress === null) return null;
  const seconds = Math.max(0, (now - progress.startedAt) / 1000);
  const recent = progress.recent.slice(-7);
  return (
    <section className={`compile-progress${progress.revising ? ' is-revising' : ''}`} aria-label="Compile progress">
      <div className="compile-progress-head">
        <span className="compile-progress-pulse" aria-hidden="true" />
        <strong aria-live="polite">{stageText(progress)}</strong>
        <span className="compile-progress-time" aria-hidden="true">{seconds.toFixed(0)} s</span>
      </div>
      {progress.revising && progress.note !== null && (
        <p className="compile-progress-finding">
          <span>Engine found:</span> {progress.note}
        </p>
      )}
      {!progress.revising && progress.stage === 'retrying' && progress.note !== null && (
        <p className="compile-progress-finding">{progress.note}</p>
      )}
      {progress.headlines.length > 0 && (
        <ol className="compile-progress-headlines" aria-label="Model plan">
          {progress.headlines.slice(-4).map((headline, index, list) => (
            <li key={headline} className={index === list.length - 1 ? 'is-current' : ''}>{headline}</li>
          ))}
        </ol>
      )}
      {recent.length > 0 && (
        <ul className="compile-progress-ops" aria-label="Operations written so far">
          {recent.map((label, index) => <li key={`${progress.operations}-${index}`}>{label}</li>)}
        </ul>
      )}
      <div className="compile-progress-foot">
        <span className="panel-note">Streamed live · nothing changes until you apply</span>
        <button type="button" className="example-chip" onClick={cancel}>Cancel</button>
      </div>
    </section>
  );
}

/** True when the current level is the empty blank-canvas seed. */
export function useLevelIsBlank(): boolean {
  return useApp((s) => {
    const level = s.draft?.level ?? s.acceptedLevel;
    return level.modules.length <= 3 && level.keys.length === 0 && level.doors.length === 0;
  });
}

/** The prompt panel (§12): describe a change, watch it compile. */
export function PromptPanel() {
  const text = useApp((s) => s.promptDraft);
  const setText = useApp((s) => s.setPromptDraft);
  const busy = useApp((s) => s.busy);
  const pendingChange = useApp((s) => s.pendingRule);
  const error = useApp((s) => s.error);
  const meta = useApp((s) => s.lastCompileMeta);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const hasKey = useApp((s) => (s.draft?.level ?? s.acceptedLevel).keys.length > 0);
  const isVault = useApp((s) => (s.draft?.level ?? s.acceptedLevel).modules.some((m) => m.id === 'key-balcony'));
  const isBlank = useLevelIsBlank();
  const changeSummary = useApp((s) => s.changeSummary);
  const history = useApp((s) => s.history);
  const loadSceneLevel = useApp((s) => s.loadLevel);
  const selection = useApp((s) => s.selection);
  const clearSelection = useApp((s) => s.clearSelection);
  const protectedIds = useApp((s) => s.protectedIds);
  const keepSelected = useApp((s) => s.keepSelected);
  const unkeep = useApp((s) => s.unkeep);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const locked = busy || pendingChange !== null;

  const submit = () => {
    void submitPrompt(text);
  };

  // One-click examples: the cache-verified canonical demo prompts, so a
  // first-time visitor can reach the signature moment without reading docs.
  const examples: { label: string; prompt: string }[] = isBlank
    ? BUILD_PROMPTS.map((entry) => ({ label: entry.label, prompt: entry.prompt }))
    : isVault
      ? [
          { label: 'Key + locked door', prompt: EXAMPLE_PROMPTS.baseline },
          {
            label: 'The switch trap',
            // Self-sufficient on a fresh scene; the canonical second step once the
            // baseline (any key) is already in place.
            prompt: hasKey ? EXAMPLE_PROMPTS.trap : EXAMPLE_PROMPTS.trapOneShot,
          },
          { label: 'Spooky night makeover', prompt: MAKEOVER_PROMPT },
          { label: 'Remove the ramp', prompt: EXAMPLE_PROMPTS.removeRamp },
          { label: 'Suggest a twist', prompt: TWIST_PROMPT },
        ]
      : [
          { label: 'Spooky night makeover', prompt: MAKEOVER_PROMPT },
          { label: 'Winter makeover', prompt: WINTER_PROMPT },
          { label: 'Suggest a twist', prompt: TWIST_PROMPT },
        ];
  const runExample = (prompt: string) => {
    setText(prompt);
    void submitPrompt(prompt);
  };


  return (
    <section className="prompt-panel" aria-label={isBlank ? 'Describe a world' : 'Describe a change'}>
      <label className="prompt-label" htmlFor="prompt-input">
        {isBlank ? 'Describe a world' : 'Describe a change'}
      </label>
      <textarea
        id="prompt-input"
        className="prompt-input"
        value={text}
        maxLength={2000}
        rows={3}
        placeholder={
          isBlank
            ? 'Describe a whole puzzle world — “a haunted forest keep with the key at the top of a tower and a dragon guarding the treasure room”.'
            : 'Describe a change, or click something in the scene first — “lock the vault with a key on the balcony”, “make it a snowy night”.'
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !locked) submit();
        }}
      />
      <div className="prompt-actions">
        <button
          type="button"
          className="prompt-submit button--primary"
          disabled={locked || text.trim().length === 0}
          onClick={submit}
        >
          {busy ? 'Building…' : isBlank ? 'Build it' : 'Compile'}
        </button>
        <span
          className={`compile-status${meta?.cached ? ' is-cached' : ''}`}
          aria-live="polite"
        >
          {meta ? (meta.cached ? 'Cached result · no new model call' : 'Fresh compile') : ''}
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
      <CompileProgressCard />
      <div className="example-prompts" role="group" aria-label="Example prompts">
        <span className="panel-note">{isBlank ? 'Build:' : 'Try:'}</span>
        {examples.map((example) => (
          <button
            key={example.label}
            type="button"
            className="example-chip"
            disabled={locked}
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
      <div className="prompt-meta">
        <span className="panel-note">
          {typeof navigator !== 'undefined' &&
          /Mac|iP/.test(
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
              ?.platform ?? navigator.platform,
          )
            ? '⌘⏎'
            : 'Ctrl+⏎'}{' '}
          {isBlank ? 'builds' : 'compiles'}
        </span>
        <label className="theme-picker">
          <span className="panel-note">Style</span>
          <select
            aria-label="Architecture theme"
            value={theme ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              const parsed = value === '' ? null : themeKeySchema.safeParse(value);
              setTheme(parsed === null ? null : parsed.success ? parsed.data : null);
            }}
          >
            <option value="">From the scene</option>
            {Object.entries(THEME_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      {history.length > 0 && (
        <details className="inspector">
          <summary><DisclosureGlyph />History</summary>
          <ol className="history-list">
            {history.map((entry, index) => (
              <li key={index}>
                <button type="button" className="history-entry" onClick={() => loadSceneLevel(entry.level, entry.theme, entry.promptHistory)}>
                  {entry.label}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {meta && (
        <details className="inspector">
          <summary><DisclosureGlyph />Generation details</summary>
          <p className="inspector-body">
            {meta.cached ? 'Original generation' : 'This generation'}: {meta.model} ·{' '}
            {meta.cached ? `original cost ${costText(meta.generationCostUsd)}` : `this call ${costText(meta.totalCostUsd)}`} ·{' '}
            {meta.attempts} attempt{meta.attempts === 1 ? '' : 's'}
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
