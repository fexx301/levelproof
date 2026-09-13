// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { applyRuleProposal } from '../src/core/level';
import { revisionId } from '../src/core/serialize';

const sceneMock = vi.hoisted(() => ({ mountScene: vi.fn() }));

vi.mock('../src/render/scene', () => ({
  mountScene: sceneMock.mountScene,
}));

import { App } from '../src/App';
import { useApp } from '../src/state/store';

function makeHandle() {
  return {
    dispose: vi.fn(),
    frameLevel: vi.fn(),
    spawnGhost: vi.fn(),
    previewOperations: vi.fn(),
    onPick: vi.fn(),
    setSelection: vi.fn(),
    setProtected: vi.fn(),
    spawnPlayer: vi.fn(),
    setKeyboardOrbit: vi.fn(),
    setAnalysis: vi.fn(),
    setAnalysisVisible: vi.fn(),
  };
}

beforeEach(() => {
  sceneMock.mountScene.mockReset();
  useApp.setState({
    acceptedLevel: baselineLevel,
    acceptedSceneId: 'balcony-vault',
    sceneId: 'balcony-vault',
    acceptedTheme: null,
    theme: null,
    acceptedPromptHistory: [],
    promptHistory: [],
    draft: null,
    pendingRule: null,
    preview: null,
    selection: [],
    protectedIds: [],
    mode: 'authoring',
    error: null,
    savedScenes: [],
  });
});

afterEach(() => cleanup());

describe('scene lifecycle boundaries', () => {
  it('rebinds picking, selection rings, and keep protections after each theme remount', async () => {
    const handles = [makeHandle(), makeHandle(), makeHandle(), makeHandle()];
    let mountCount = 0;
    sceneMock.mountScene.mockImplementation(() => handles[mountCount++] ?? handles.at(-1));
    render(<App />);

    await waitFor(() => expect(sceneMock.mountScene).toHaveBeenCalledTimes(1));
    const initialPick = handles[0]!.onPick.mock.calls.at(-1)?.[0] as (id: string | null) => void;
    act(() => initialPick('gallery'));
    expect(useApp.getState().selection).toEqual(['gallery']);
    act(() => useApp.getState().keepSelected());

    for (const [index, theme] of (['futuristic', 'patina', 'ivory'] as const).entries()) {
      act(() => useApp.getState().setTheme(theme));
      const expectedMounts = index + 2;
      await waitFor(() => expect(sceneMock.mountScene).toHaveBeenCalledTimes(expectedMounts));
      const current = handles[expectedMounts - 1]!;
      expect(current.onPick).toHaveBeenCalledWith(expect.any(Function));
      expect(current.setSelection).toHaveBeenLastCalledWith(['gallery']);
      expect(current.setProtected).toHaveBeenLastCalledWith(['gallery']);
    }

    const final = handles[3]!;
    const remountedPick = final.onPick.mock.calls.at(-1)?.[0] as (id: string | null) => void;
    act(() => remountedPick(null));
    expect(useApp.getState().selection).toEqual([]);
    act(() => remountedPick('gallery'));
    expect(useApp.getState().selection).toEqual(['gallery']);
  });

  it('passes the validated atomic candidate to the renderer as one preview state', async () => {
    const handle = makeHandle();
    sceneMock.mountScene.mockReturnValue(handle);
    const proposal = {
      oldRequirements: baselineLevel.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem' as const, id: 'brass-key' },
        { kind: 'removeDoor' as const, id: 'vault-door' },
      ],
    };
    const applied = applyRuleProposal(baselineLevel, proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const preview = {
      source: 'ai' as const,
      baseRevision: revisionId(baselineLevel),
      before: baselineLevel,
      candidate: applied.level,
      operations: proposal.operations,
    };
    useApp.setState({ preview });

    render(<App />);
    await waitFor(() => expect(handle.previewOperations).toHaveBeenCalledWith(preview));
    expect(handle.previewOperations.mock.calls.at(-1)?.[0]?.candidate).toEqual(applied.level);
  });
});
