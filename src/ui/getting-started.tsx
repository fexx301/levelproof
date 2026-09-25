import { useEffect, useMemo, useState } from 'react';
import { BUILD_PROMPTS, EXAMPLE_PROMPTS, MAKEOVER_PROMPT } from './example-prompts.js';
import { useApp } from '../state/store.js';

const GUIDE_KEY = 'levelproof:getting-started:dismissed';

interface GuideStep {
  label: string;
  detail: string;
  complete: boolean;
}

/**
 * A small, dismissible first-use guide. It reports state already completed in
 * the real editor; it never substitutes a canned scene for a model result.
 */
export function GettingStarted() {
  const [dismissed, setDismissed] = useState(true);
  const pendingRule = useApp((s) => s.pendingRule);
  const lastPrompt = useApp((s) => s.lastPrompt);
  const history = useApp((s) => s.history);
  const draft = useApp((s) => s.draft);
  const changeSummary = useApp((s) => s.changeSummary);
  const mode = useApp((s) => s.mode);
  const play = useApp((s) => s.play);
  const repair = useApp((s) => s.repair);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const setPromptDraft = useApp((s) => s.setPromptDraft);
  const samplePrompt = useApp((s) => {
    const level = s.draft?.level ?? s.acceptedLevel;
    if (level.modules.length <= 3 && level.keys.length === 0) return BUILD_PROMPTS[0].prompt;
    return level.modules.some((m) => m.id === 'key-balcony') ? EXAMPLE_PROMPTS.baseline : MAKEOVER_PROMPT;
  });

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(GUIDE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  const steps = useMemo<GuideStep[]>(() => {
    const described = lastPrompt !== null || pendingRule !== null || history.length > 0 || draft !== null;
    const reviewed = history.length > 0 || draft !== null || changeSummary !== null;
    const tested = mode !== 'authoring' || play.atGoal || play.trapped || play.goalViolated;
    const understood = repair.status === 'done';
    return [
      { label: 'Describe', detail: 'Ask for one supported change in plain language.', complete: described },
      { label: 'Review', detail: 'Inspect the before / after preview, then approve it.', complete: reviewed },
      { label: 'Test', detail: 'Play or watch the checker’s ghost replay.', complete: tested },
      { label: 'Repair', detail: 'Show a verified failure and search a grounded fix.', complete: understood },
    ];
  }, [changeSummary, draft, history.length, lastPrompt, mode, pendingRule, play, repair.status]);

  if (dismissed) return null;
  const completed = steps.filter((step) => step.complete).length;
  const described = steps[0]?.complete ?? false;

  const dismiss = (): void => {
    setDismissed(true);
    try {
      window.localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      // The guide remains dismissible for this session when storage is blocked.
    }
  };

  return (
    <section className="getting-started" aria-label="Getting started">
      <div className="getting-started-head">
        <h2>Describe → test → repair</h2>
        <button type="button" className="guide-dismiss" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      <ol className="guide-steps" aria-label={`${completed} of ${steps.length} guide steps complete`}>
        {steps.map((step, index) => (
          <li key={step.label} className={step.complete ? 'is-complete' : ''} title={step.detail}>
            <span className="guide-step-number" aria-hidden="true">
              {step.complete ? '✓' : index + 1}
            </span>
            <span>
              <strong>{step.label}</strong>
              <small className="visually-hidden">{step.detail}</small>
            </span>
          </li>
        ))}
      </ol>
      {!described && (
        <button
          type="button"
          className="example-chip"
          onClick={() => {
            setPromptDraft(samplePrompt);
            void submitPrompt(samplePrompt);
          }}
        >
          Try the sample request
        </button>
      )}
    </section>
  );
}
