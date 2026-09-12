import { useEffect, useMemo, useRef, useState } from 'react';
import type { Cardinal, Level } from '../shared/schema';
import { verify, type Report } from './core/verifier';
import { compileLevel } from './core/topology';
import { actorBridge } from './render/bridge';
import { mountScene, type SceneHandle } from './render/scene';
import { SCENES, useApp } from './state/store';
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
  const sceneId = useApp((s) => s.sceneId);
  const loadScene = useApp((s) => s.loadScene);
  const discardDraft = useApp((s) => s.discardDraft);
  const resetVault = useApp((s) => s.resetVault);
  const saveScene = useApp((s) => s.saveScene);
  const shareCurrent = useApp((s) => s.shareCurrent);
  const savedScenes = useApp((s) => s.savedScenes);
  const viaShare = useApp((s) => s.viaShare);
  const headerNote = useApp((s) => s.headerNote);
  const startPlay = useApp((s) => s.startPlay);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);
  const [resetArmed, setResetArmed] = useState(false);
  const resetArmTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (resetArmTimer.current !== null) window.clearTimeout(resetArmTimer.current);
    };
  }, []);

  const level = draft?.level ?? acceptedLevel;
  const { report, ms } = useMemo(() => {
    const t0 = performance.now();
    const result = verify(level);
    return { report: result, ms: performance.now() - t0 };
  }, [level]);

  // Escape exits any non-authoring mode (the header control promises it).
  useEffect(() => {
    if (mode === 'authoring') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useApp.getState().exitToAuthoring();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // Moving keyboard focus to the panel on mode change confirms the switch.
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (mode === 'authoring') return;
    panelRef.current?.focus();
  }, [mode]);
  return (
    <div className="app" data-mode={mode}>
      <header className="app-header">
        <h1 className="app-title">LevelProof</h1>
        <p className="app-sub">An AI puzzle creator with automatic playtesting</p>
        <div className="header-actions">
          {mode === 'authoring' && draft && <span className="draft-badge">Draft — not accepted</span>}
          {mode === 'authoring' && (
            <label className="scene-select-label">
              <span className="visually-hidden">Scene</span>
              <select
                className="scene-select"
                value={savedScenes.some((sv) => `saved:${sv.id}` === sceneId) ? sceneId : undefined}
                onChange={(event) => loadScene(event.target.value)}
              >
                <optgroup label="Scenes">
                  {SCENES.map((scene) => (
                    <option key={scene.id} value={scene.id}>
                      {scene.label}
                    </option>
                  ))}
                </optgroup>
                {savedScenes.length > 0 && (
                  <optgroup label="My puzzles">
                    {savedScenes.map((sv) => (
                      <option key={sv.id} value={`saved:${sv.id}`}>
                        {sv.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {mode === 'authoring' && (
            <>
              <button type="button" onClick={undo} disabled={!previousAccepted}>
                Undo
              </button>
              <button type="button" onClick={saveScene}>
                Save
              </button>
              <button type="button" onClick={shareCurrent}>
                Share
              </button>
              {headerNote !== null && <span className="control-status">{headerNote}</span>}
              {draft && (
                <button type="button" onClick={discardDraft}>
                  Return to accepted
                </button>
              )}
              <button type="button" onClick={startPlay}>
                {draft ? 'Play the draft' : 'Play the level'}
              </button>
              {resetArmed && (
                <span role="status" className="control-status">
                  Reset armed — press again within 3 seconds
                </span>
              )}
              <button
                type="button"
                className={`reset-button${resetArmed ? ' button--danger' : ''}`}
                onClick={() => {
                  if (resetArmTimer.current !== null) {
                    window.clearTimeout(resetArmTimer.current);
                    resetArmTimer.current = null;
                  }
                  if (resetArmed) {
                    resetVault();
                    setResetArmed(false);
                  } else {
                    setResetArmed(true);
                    resetArmTimer.current = window.setTimeout(() => {
                      setResetArmed(false);
                      resetArmTimer.current = null;
                    }, 3000);
                  }
                }}
              >
                {resetArmed ? 'Confirm reset' : 'Reset to the empty vault'}
              </button>
            </>
          )}
          {mode !== 'authoring' && (
            <button type="button" onClick={exitToAuthoring}>
              {viaShare ? 'Remix this puzzle (Esc)' : 'Back to editing (Esc)'}
            </button>
          )}
        </div>
      </header>
      <div className="rule-bar" id="rules" tabIndex={-1} role="group" aria-label="Active rules">
        <RuleChips level={level} />
      </div>
      <main className="app-main">
        <Viewport level={level} mode={mode} report={report} />
        <aside className="side-panel" ref={panelRef} tabIndex={-1}>
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

  // The engine's per-module recovery analysis renders as floor overlays —
  // the author's view of every dead-end zone and unreachable span. Hidden
  // while playing: it would spoil the trap.
  useEffect(() => {
    sceneRef.current?.setAnalysis(report.complete ? (report.recoveryMap ?? null) : null);
  }, [report, level]);
  useEffect(() => {
    sceneRef.current?.setAnalysisVisible(mode !== 'playing');
  }, [mode, level]);

  // Repair preview markers follow the store (§9 before/after).
  const previewOps = useApp((st) => st.previewOps);
  useEffect(() => {
    sceneRef.current?.previewOperations(previewOps);
  }, [previewOps, level]);

  // Click-to-select (§12): picked entities toggle store selection; empty
  // space clears it. Selection rings follow the store.
  const selection = useApp((st) => st.selection);
  const toggleSelect = useApp((st) => st.toggleSelect);
  const clearSelection = useApp((st) => st.clearSelection);
  useEffect(() => {
    sceneRef.current?.onPick((id) => {
      if (id === null) clearSelection();
      else toggleSelect(id);
    });
    return () => sceneRef.current?.onPick(null);
  }, [level, toggleSelect, clearSelection]);
  useEffect(() => {
    sceneRef.current?.setSelection(selection);
  }, [selection, level]);
  const protectedIds = useApp((st) => st.protectedIds);
  useEffect(() => {
    sceneRef.current?.setProtected(protectedIds);
  }, [protectedIds, level]);

  // Ghost: replays a verifier witness route — never a fabricated one.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || mode !== 'watching' || witnessKind === null) return;
    const replayRoute = useApp.getState().repairReplay;
    const option =
      witnessKind === 'replay'
        ? replayRoute !== null && replayRoute.length > 0
          ? { kind: 'replay' as const, route: replayRoute, missingKeys: [] }
          : null
        : witnessOptions(report).find((o) => o.kind === witnessKind);
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
              ? `Reached the goal without the ${info.missingKeys.join(' and the ')}.`
              : info.kind === 'replay'
                ? 'Route complete — the same moves no longer strand the player.'
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
    scene.setKeyboardOrbit(false);
    const actor = scene.spawnPlayer({
      onState: (info) => useApp.setState({ play: info }),
    });
    actorBridge.setPlayer(actor);
    const onKey = (event: KeyboardEvent) => {
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
      scene.setKeyboardOrbit(true);
      actorBridge.setPlayer(null);
      actor.dispose();
    };
  }, [level, mode]);

  const viewportLabel =
    mode === 'playing'
      ? '3D view of the current level — WASD or arrows to move, R restart'
      : '3D view of the current level — drag to orbit, scroll to zoom, arrow keys orbit when focused';
  return <div className="viewport" ref={hostRef} role="region" aria-label={viewportLabel} />;
}

