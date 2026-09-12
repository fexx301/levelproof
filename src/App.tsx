import { useEffect, useMemo, useRef } from 'react';
import type { Cardinal, Level } from '../shared/schema';
import { verify, type Report } from './core/verifier';
import { compileLevel } from './core/topology';
import { actorBridge } from './render/bridge';
import { mountScene, type SceneHandle } from './render/scene';
import { useApp } from './state/store';
import { CheckStrip, RuleChips } from './ui/check-strip';
import { PlayPanel } from './ui/play-panel';
import { PlaytesterPanel, witnessOptions } from './ui/playtester';
import { PromptPanel } from './ui/prompt-panel';
import { RepairPanel } from './ui/repair-panel';
import { ResultCards } from './ui/result-cards';

type Mode = 'authoring' | 'watching' | 'playing';

const KEY_DIRECTIONS: Record<string, Cardinal> = {
  w: 'N',
  W: 'N',
  ArrowUp: 'N',
  s: 'S',
  S: 'S',
  ArrowDown: 'S',
  a: 'W',
  A: 'W',
  ArrowLeft: 'W',
  d: 'E',
  D: 'E',
  ArrowRight: 'E',
};

/**
 * The authoring surface (§12): the diorama, the prompt panel, active-rule
 * chips, result cards, the playtester, manual play, and the three-check
 * strip. One accepted checkpoint plus at most one editable draft (§11).
 */
export function App() {
  const acceptedLevel = useApp((s) => s.acceptedLevel);
  const draft = useApp((s) => s.draft);
  const mode = useApp((s) => s.mode);
  const previousAccepted = useApp((s) => s.previousAccepted);
  const undo = useApp((s) => s.undo);
  const discardDraft = useApp((s) => s.discardDraft);
  const resetVault = useApp((s) => s.resetVault);
  const startPlay = useApp((s) => s.startPlay);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);

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
          {mode === 'authoring' && draft && <span className="draft-badge">Draft — not accepted</span>}
          {mode === 'authoring' && (
            <>
              <button type="button" onClick={undo} disabled={!previousAccepted}>
                Undo
              </button>
              {draft && (
                <button type="button" onClick={discardDraft}>
                  Return to accepted
                </button>
              )}
              <button type="button" onClick={startPlay}>
                Play the draft
              </button>
              <button type="button" onClick={resetVault}>
                Reset to the empty vault
              </button>
            </>
          )}
          {mode !== 'authoring' && (
            <button type="button" onClick={exitToAuthoring}>
              Back to editing (Esc)
            </button>
          )}
        </div>
      </header>
      <div className="rule-bar" aria-label="Active rules">
        <RuleChips level={level} />
      </div>
      <main className="app-main">
        <Viewport level={level} mode={mode} report={report} />
        <aside className="side-panel">
          {mode === 'authoring' && (
            <>
              <PromptPanel />
              <ResultCards />
              <RepairPanel report={report} />
              <PlaytesterPanel report={report} />
              <CheckStrip report={report} ms={ms} />
            </>
          )}
          {mode === 'watching' && <PlaytesterPanel report={report} />}
          {mode === 'playing' && <PlayPanel level={level} report={report} />}
        </aside>
      </main>
    </div>
  );
}

function Viewport({ level, mode, report }: { level: Level; mode: Mode; report: Report }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const witnessKind = useApp((s) => s.ghost.witnessKind);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mountScene(host, compileLevel(level));
    sceneRef.current = handle;
    return () => {
      handle.dispose();
      sceneRef.current = null;
    };
  }, [level]);

  // Ghost: replays a verifier witness route — never a fabricated one.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || mode !== 'watching' || witnessKind === null) return;
    const option = witnessOptions(report).find((o) => o.kind === witnessKind);
    if (!option || option.route.length === 0) return;
    const actor = scene.spawnGhost(option.route, option.kind, option.missingKeys, {
      onTick: (state) => {
        const current = useApp.getState().ghost;
        useApp.setState({ ghost: { ...current, ...state, witnessKind } });
      },
      onArrive: () => {},
      onFinish: (info) => {
        const current = useApp.getState().ghost;
        const endNote =
          info.kind === 'dead_end'
            ? `Stranded at “${info.endState.moduleId}” — no winning route remains.`
            : info.kind === 'bypass'
              ? `Reached the goal without: ${info.missingKeys.join(', ')}.`
              : 'Goal reached.';
        useApp.setState({ ghost: { ...current, finished: true, playing: false, endNote } });
      },
    });
    actorBridge.setGhost(actor);
    actor.play();
    return () => {
      actorBridge.setGhost(null);
      actor.dispose();
    };
  }, [level, mode, witnessKind, report]);

  // Manual play: same core step as the checker; one move at a time.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || mode !== 'playing') return;
    const actor = scene.spawnPlayer({
      onState: (info) => useApp.setState({ play: info }),
    });
    actorBridge.setPlayer(actor);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        useApp.getState().exitToAuthoring();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        actor.restart();
        return;
      }
      const dir = KEY_DIRECTIONS[event.key];
      if (dir) {
        event.preventDefault();
        actor.move(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      actorBridge.setPlayer(null);
      actor.dispose();
    };
  }, [level, mode]);

  return <div className="viewport" ref={hostRef} aria-label="3D scene" />;
}

