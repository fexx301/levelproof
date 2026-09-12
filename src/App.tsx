import { useEffect, useMemo, useRef } from 'react';
import type { Level } from '../shared/schema';
import { compileLevel } from './core/topology';
import { verify } from './core/verifier';
import { mountScene } from './render/scene';
import { useApp } from './state/store';
import { CheckStrip, RuleChips } from './ui/check-strip';
import { PromptPanel } from './ui/prompt-panel';
import { ResultCards } from './ui/result-cards';

/**
 * The authoring surface: the diorama, the prompt panel, active-rule chips,
 * result cards, and the three-check strip. One accepted checkpoint plus at
 * most one editable draft (§11); the scene shows the draft when one exists.
 */
export function App() {
  const acceptedLevel = useApp((s) => s.acceptedLevel);
  const draft = useApp((s) => s.draft);
  const previousAccepted = useApp((s) => s.previousAccepted);
  const undo = useApp((s) => s.undo);
  const discardDraft = useApp((s) => s.discardDraft);
  const resetVault = useApp((s) => s.resetVault);

  const level = draft?.level ?? acceptedLevel;
  const { report, ms } = useMemo(() => {
    const t0 = performance.now();
    const result = verify(level);
    return { report: result, ms: performance.now() - t0 };
  }, [level]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">LevelProof</h1>
        <p className="app-sub">An AI puzzle creator with automatic playtesting</p>
        <div className="header-actions">
          {draft && <span className="draft-badge">Draft — not accepted</span>}
          <button type="button" onClick={undo} disabled={!previousAccepted}>
            Undo
          </button>
          {draft && (
            <button type="button" onClick={discardDraft}>
              Return to accepted
            </button>
          )}
          <button type="button" onClick={resetVault}>
            Reset to the empty vault
          </button>
        </div>
      </header>
      <div className="rule-bar" aria-label="Active rules">
        <RuleChips level={level} />
      </div>
      <main className="app-main">
        <Viewport level={level} />
        <aside className="side-panel">
          <PromptPanel />
          <ResultCards />
          <CheckStrip report={report} ms={ms} />
        </aside>
      </main>
    </div>
  );
}

function Viewport({ level }: { level: Level }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mountScene(host, compileLevel(level));
    return () => handle.dispose();
  }, [level]);
  return <div className="viewport" ref={hostRef} aria-label="3D scene" />;
}
