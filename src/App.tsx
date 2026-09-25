import { useEffect, useMemo, useRef, useState } from 'react';
import type { Cardinal, Level, ThemeKey } from '../shared/schema';
import { verify, type Report } from './core/verifier';
import { compileLevel } from './core/topology';
import { actorBridge } from './render/bridge';
import { mountScene, type SceneHandle } from './render/scene';
import { SCENES, useApp } from './state/store';
import { CheckStrip, RuleChips } from './ui/check-strip';
import { useLevelIsBlank } from './ui/prompt-panel';
import { PlayPanel, requestHint } from './ui/play-panel';
import { SoundToggle } from './ui/sound-toggle';
import { PlaytesterPanel, witnessOptions } from './ui/playtester';
import { PromptPanel } from './ui/prompt-panel';
import { RepairPanel } from './ui/repair-panel';
import { ResultCards } from './ui/result-cards';
import { savedSceneOptionLabel } from './state/persistence';
import { GettingStarted } from './ui/getting-started';
import { SceneObjectPicker } from './ui/scene-object-picker';
import { KEY_INTENTS, relativeCardinal, type MoveIntent } from './ui/relative-direction';
import { BUILD_PROMPTS } from './ui/example-prompts';

type Mode = 'authoring' | 'watching' | 'playing';

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
  const deleteSaved = useApp((s) => s.deleteSaved);
  const shareCurrent = useApp((s) => s.shareCurrent);
  const savedScenes = useApp((s) => s.savedScenes);
  const viaShare = useApp((s) => s.viaShare);
  const recoveryStatus = useApp((s) => s.recoveryStatus);
  const clearRecovery = useApp((s) => s.clearRecovery);
  const retryRecovery = useApp((s) => s.retryRecovery);
  const busy = useApp((s) => s.busy);
  const pendingRule = useApp((s) => s.pendingRule);
  const changeSummary = useApp((s) => s.changeSummary);
  const promptDraft = useApp((s) => s.promptDraft);
  const selection = useApp((s) => s.selection);
  const protectedIds = useApp((s) => s.protectedIds);
  const theme = useApp((s) => s.theme);
  const headerNote = useApp((s) => s.headerNote);
  const selectedSaved = savedScenes.find((saved) => `saved:${saved.recordKey}` === sceneId);
  const startPlay = useApp((s) => s.startPlay);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);
  const [resetArmed, setResetArmed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
  // An AI proposal is shown as the world it would create, not as markers on
  // the old one; nothing is applied until the author approves.
  const preview = useApp((s) => s.preview);
  const pendingTheme = useApp((s) => s.pendingRule?.nextTheme ?? null);
  const previewing = mode === 'authoring' && preview?.source === 'ai';
  const viewLevel = previewing ? preview.candidate : level;
  const viewReport = useMemo(() => (viewLevel === level ? report : verify(viewLevel)), [viewLevel, level, report]);
  const viewTheme = previewing ? (pendingTheme ?? theme) : theme;
  const originSceneId = useApp((s) => s.originSceneId);
  const originLabel = SCENES.find((scene) => scene.id === originSceneId)?.label ?? 'the scene';

  // Escape exits any non-authoring mode (the header control promises it).
  useEffect(() => {
    if (mode === 'authoring') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useApp.getState().exitToAuthoring();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);
  useEffect(() => {
    if (recoveryStatus === 'ready') return;
    const hasWork = busy || draft !== null || pendingRule !== null || history.length > 0 || changeSummary !== null ||
      promptDraft.length > 0 || selection.length > 0 || protectedIds.length > 0 || theme !== null;
    if (!hasWork) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => window.removeEventListener('beforeunload', warnBeforeLeave);
  }, [recoveryStatus, busy, draft, pendingRule, history.length, changeSummary, promptDraft, selection.length, protectedIds.length, theme]);

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
                value={sceneId}
                onChange={(event) => loadScene(event.target.value)}
              >
                {sceneId === '' && <option value="">Unsaved puzzle</option>}
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
                      <option key={sv.recordKey} value={`saved:${sv.recordKey}`}>
                        {savedSceneOptionLabel(sv)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {mode === 'authoring' && (
            <>
              <button
                type="button"
                className="header-menu-toggle"
                aria-expanded={menuOpen}
                aria-controls="header-secondary"
                onClick={() => setMenuOpen((open) => !open)}
              >
                {menuOpen ? 'Close menu' : 'More'}
              </button>
              <div id="header-secondary" className={`header-secondary${menuOpen ? ' is-open' : ''}`}>
                <button type="button" onClick={undo} disabled={!previousAccepted}>
                  Undo
                </button>
                <button type="button" onClick={saveScene}>
                  {draft ? 'Save accepted checkpoint' : 'Save checkpoint'}
                </button>
                <button type="button" onClick={shareCurrent}>
                  {draft ? 'Share accepted' : 'Share'}
                </button>
                {selectedSaved && (
                  <button type="button" onClick={() => deleteSaved(selectedSaved.recordKey)}>
                    Remove saved
                  </button>
                )}
                {draft && (
                  <button type="button" onClick={discardDraft}>
                    Return to accepted
                  </button>
                )}
                {resetArmed && (
                  <span role="status" className="control-status">
                    Reset armed — press again within 3 seconds
                  </span>
                )}
                <button
                  type="button"
                  title={`Reset to the original ${originLabel}`}
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
                  {resetArmed ? 'Confirm start over' : 'Start over'}
                </button>
              </div>
              {headerNote !== null && <span className="control-status">{headerNote}</span>}
              <button type="button" className="button--play" onClick={startPlay}>
                <span aria-hidden="true">▶ </span>
                {draft ? 'Play the draft' : 'Play the level'}
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
      {recoveryStatus === 'malformed' && (
        <div className="recovery-notice recovery-notice--error" role="alert">
          <span>Saved session recovery is unreadable. It has been left untouched; clear that recovery entry to start a new one.</span>
          <button type="button" onClick={clearRecovery}>Clear unreadable recovery</button>
        </div>
      )}
      {recoveryStatus === 'unavailable' && (
        <div className="recovery-notice" role="status">
          <span>Local recovery is unavailable. Changes in this tab may be lost if it closes.</span>
          <button type="button" onClick={retryRecovery}>Retry recovery save</button>
        </div>
      )}
      <main className="app-main">
        <Viewport level={viewLevel} mode={mode} report={viewReport} theme={viewTheme} previewing={previewing} />
        <aside
          className="side-panel"
          ref={panelRef}
          tabIndex={-1}
          data-preview-open={pendingRule !== null ? 'true' : undefined}
        >
          {mode === 'authoring' && (
            <>
              <PromptPanel />
              <GettingStarted />
              <SceneObjectPicker level={level} />
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

/**
 * The blank canvas invites a whole world: build chips in the viewport itself,
 * then a live status while the model works (the full feed is in the panel).
 */
function BlankCanvasWelcome() {
  const blank = useLevelIsBlank();
  const busy = useApp((s) => s.busy);
  const pending = useApp((s) => s.pendingRule !== null);
  const progress = useApp((s) => s.compileProgress);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const setPromptDraft = useApp((s) => s.setPromptDraft);
  if (!blank || pending) return null;
  if (busy) {
    const latest = progress?.recent.at(-1) ?? progress?.headlines.at(-1) ?? 'Reading your description…';
    return (
      <div className="viewport-welcome viewport-welcome--busy" role="status">
        <p className="viewport-welcome-kicker">Building your world</p>
        <p className="viewport-welcome-latest">{latest}</p>
      </div>
    );
  }
  return (
    <section className="viewport-welcome" aria-label="Start a world">
      <h2>Describe a world</h2>
      <p>One sentence becomes a playable 3D puzzle — and the engine proves it can be won before you keep it.</p>
      <div className="viewport-welcome-chips">
        {BUILD_PROMPTS.map((build) => (
          <button
            key={build.label}
            type="button"
            onClick={() => {
              setPromptDraft(build.prompt);
              void submitPrompt(build.prompt);
            }}
          >
            {build.label}
          </button>
        ))}
      </div>
      <p className="viewport-welcome-hint">…or write your own in the panel.</p>
    </section>
  );
}

function Viewport({ level, mode, report, theme, previewing }: { level: Level; mode: Mode; report: Report; theme: ThemeKey | null; previewing: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const [sceneFailure, setSceneFailure] = useState<string | null>(null);
  const [sceneAttempt, setSceneAttempt] = useState(0);
  const witnessKind = useApp((s) => s.ghost.witnessKind);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onRenderState = (event: Event): void => {
      const state = (event as CustomEvent<'ready' | 'lost'>).detail;
      setSceneFailure(state === 'lost' ? 'The browser lost the 3D graphics context.' : null);
    };
    host.addEventListener('levelproof:render-state', onRenderState);
    let handle: SceneHandle | null = null;
    try {
      handle = mountScene(host, compileLevel(level), theme ?? undefined);
      sceneRef.current = handle;
      handle.onFacing((facing) => {
        if (useApp.getState().facing !== facing) useApp.setState({ facing });
      });
      setSceneFailure(null);
    } catch {
      host.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
      sceneRef.current = null;
      setSceneFailure('The browser could not start the 3D renderer.');
    }
    return () => {
      host.removeEventListener('levelproof:render-state', onRenderState);
      handle?.dispose();
      sceneRef.current = null;
    };
  }, [level, theme, sceneAttempt]);

  // The engine's per-module recovery analysis renders as floor overlays —
  // the author's view of every dead-end zone and unreachable span. Hidden
  // while playing: it would spoil the trap.
  useEffect(() => {
    sceneRef.current?.setAnalysis(report.complete ? (report.recoveryMap ?? null) : null);
  }, [report, level, theme]);
  useEffect(() => {
    sceneRef.current?.setAnalysisVisible(mode !== 'playing');
  }, [mode, level, theme]);

  // Repair preview markers follow the store (§9 before/after).
  const preview = useApp((st) => st.preview);
  useEffect(() => {
    sceneRef.current?.previewOperations(preview);
  }, [preview, level, theme]);

  // Click-to-select (§12): picked entities toggle store selection; empty
  // space clears it. Selection rings follow the store.
  const selection = useApp((st) => st.selection);
  const toggleSelect = useApp((st) => st.toggleSelect);
  const clearSelection = useApp((st) => st.clearSelection);
  useEffect(() => {
    const scene = sceneRef.current;
    scene?.onPick((id) => {
      if (id === null) clearSelection();
      else toggleSelect(id);
    });
    return () => scene?.onPick(null);
  }, [level, theme, toggleSelect, clearSelection]);
  useEffect(() => {
    sceneRef.current?.setSelection(selection);
  }, [selection, level, theme]);
  const protectedIds = useApp((st) => st.protectedIds);
  useEffect(() => {
    sceneRef.current?.setProtected(protectedIds);
  }, [protectedIds, level, theme]);
  const evidence = useApp((st) => st.evidence);
  useEffect(() => {
    sceneRef.current?.setEvidence(evidence?.implicatedIds ?? []);
  }, [evidence, level, theme]);

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
        useApp.setState({ ghost: { ...current, ...state, witnessKind, endNote: state.finished ? current.endNote : null } });
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
    }, evidence?.decisiveMoveIndex ?? null);
    actorBridge.setGhost(actor);
    actor.play();
    return () => {
      actorBridge.setGhost(null);
      actor.dispose();
    };
  }, [level, mode, witnessKind, report, theme]);

  // Manual play: same core step as the checker; one move at a time.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || mode !== 'playing') return;
    scene.setKeyboardOrbit(false);
    // Movement keys held down, by physical key, most recently pressed last:
    // a run carries on through landings without waiting for key auto-repeat.
    const held = new Map<string, MoveIntent>();
    const heldDirection = (): Cardinal | null => {
      const intent = [...held.values()].at(-1);
      return intent === undefined ? null : relativeCardinal(useApp.getState().facing, intent);
    };
    const actor = scene.spawnPlayer({
      onState: (info) => useApp.setState({ play: info }),
      heldDirection,
    });
    actorBridge.setPlayer(actor);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'r' || event.key === 'R') {
        actor.restart();
        return;
      }
      if ((event.key === 'h' || event.key === 'H') && !event.repeat) {
        requestHint();
        return;
      }
      // Camera-relative: W / ↑ always walks away from the viewer.
      const intent = KEY_INTENTS[event.key];
      if (intent) {
        event.preventDefault();
        if (!event.repeat) {
          held.delete(event.code);
          held.set(event.code, intent);
        }
        actor.move(relativeCardinal(useApp.getState().facing, intent), !event.repeat);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      held.delete(event.code);
    };
    // A key released while the page is not focused never reports its keyup.
    const releaseAll = () => held.clear();
    const onVisibility = () => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.setKeyboardOrbit(true);
      actorBridge.setPlayer(null);
      actor.dispose();
    };
  }, [level, mode, theme]);

  // Manual play chases the player unless the author asked for the overview.
  const followCamera = useApp((st) => st.followCamera);
  useEffect(() => {
    sceneRef.current?.setFollow(followCamera);
  }, [followCamera, mode, level, theme]);

  const viewportLabel =
    mode === 'playing'
      ? '3D view of the current level — WASD or arrows to move (relative to the camera), R restart'
      : '3D view of the current level — drag to orbit, scroll to zoom, arrow keys orbit when focused';
  return (
    <div className="viewport" ref={hostRef} role="region" aria-label={viewportLabel}>
      <div className="viewport-top">
        <button
          className="viewport-home"
          type="button"
          onClick={() => {
            if (mode !== 'authoring') useApp.setState({ followCamera: false });
            sceneRef.current?.frameLevel();
          }}
        >
          Frame level
        </button>
        <SoundToggle />
        <div className="viewport-rules" id="rules" tabIndex={-1} role="group" aria-label="Active rules">
          <RuleChips level={level} />
        </div>
      </div>
      {mode === 'authoring' && !previewing && <BlankCanvasWelcome />}
      {previewing && (
        <p className="viewport-preview-badge" role="status">
          Preview — not applied yet
        </p>
      )}
      {level.switches.length > 0 && (
        <p className="viewport-legend">Hexagonal plates can open gates · Triangular plates can seal routes</p>
      )}
      {sceneFailure !== null && (
        <div className="scene-failure" role="alert">
          <h2>3D view unavailable</h2>
          <p>{sceneFailure} Your puzzle and verification results are still available.</p>
          <button type="button" onClick={() => setSceneAttempt((attempt) => attempt + 1)}>Retry 3D view</button>
        </div>
      )}
    </div>
  );
}
