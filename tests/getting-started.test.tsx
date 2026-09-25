// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GettingStarted } from '../src/ui/getting-started';
import { useApp } from '../src/state/store';

beforeEach(() => {
  window.localStorage.clear();
  useApp.setState({
    pendingRule: null,
    lastPrompt: null,
    history: [],
    draft: null,
    changeSummary: null,
    mode: 'authoring',
    play: { at: '', keys: [], switches: [], trapped: false, atGoal: false, goalViolated: false },
    evidence: null,
    repair: { status: 'idle', candidates: [], explored: 0, durationMs: 0, note: null, applyError: null },
  });
});

afterEach(() => cleanup());

describe('getting started guide', () => {
  it('shows a real-workflow sample action and can be dismissed', async () => {
    render(<GettingStarted />);
    expect(await screen.findByRole('heading', { name: 'Describe → test → repair' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the sample request' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'Describe → test → repair' })).toBeNull();
    expect(window.localStorage.getItem('levelproof:getting-started:dismissed')).toBe('1');
  });

  it('stays hidden after the user has dismissed it across remounts', async () => {
    window.localStorage.setItem('levelproof:getting-started:dismissed', '1');
    render(<GettingStarted />);
    expect(screen.queryByRole('heading', { name: 'Describe → test → repair' })).toBeNull();
  });

  it('does not mark Repair complete merely because a failure was shown', async () => {
    useApp.setState({
      lastPrompt: 'Add a switch trap.',
      evidence: {
        check: 'recovery', revisionId: 'rev-1', witnessKind: 'dead_end', route: [],
        decisiveMoveIndex: 1,
        implicatedIds: ['gallery-door'], focusModuleId: 'gallery', fact: 'Stranded.', suggestedAction: 'Repair it.',
      },
    });
    render(<GettingStarted />);
    expect(await screen.findByLabelText('1 of 4 guide steps complete')).toBeTruthy();
  });
});
