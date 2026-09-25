// @vitest-environment jsdom
/**
 * Prompt-panel interaction tests (§12): the regression guard for the
 * controlled-input seam. A deploy once shipped a textarea whose onChange had
 * been dropped — typing never reached React state, Compile resubmitted the
 * last chip text, and every check in the suite stayed green. These tests
 * fail on exactly that: typing must update the controlled value (verified
 * across a re-render, since a missing onChange only reverts on the next
 * render) and Compile must submit the typed prompt (with onChange missing,
 * the button stays disabled and the spy never fires).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptPanel } from '../src/ui/prompt-panel';
import { useApp } from '../src/state/store';

// Captured before any test mutates the store: the spy test replaces
// submitPrompt, and every test must leave the real action behind.
const originalSubmitPrompt = useApp.getState().submitPrompt;

afterEach(() => {
  cleanup();
  useApp.setState({ submitPrompt: originalSubmitPrompt });
});

beforeEach(() => {
  useApp.setState({
    busy: false,
    error: null,
    promptDraft: '',
    pendingRule: null,
    lastCompileMeta: null,
    selection: [],
    protectedIds: [],
  });
});

const typeInto = (text: string): HTMLTextAreaElement => {
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  return input;
};

describe('prompt panel controlled input (the onChange seam)', () => {
  it('typing updates the controlled value and survives a re-render', () => {
    render(<PromptPanel />);
    const input = typeInto('Move the key here.');
    // Force a re-render of the panel: a controlled input without onChange
    // reverts to stale state exactly here.
    useApp.setState({ selection: ['gallery'] });
    expect(input.value).toBe('Move the key here.');
  });

  it('Compile submits exactly the typed prompt', () => {
    const spy = vi.fn();
    useApp.setState({ submitPrompt: spy });
    render(<PromptPanel />);
    typeInto('Remove the ramp.');
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Remove the ramp.');
  });

  it('Compile is disabled while the box is empty', () => {
    render(<PromptPanel />);
    const button = screen.getByRole('button', { name: 'Compile' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    typeInto('Remove the ramp.');
    expect(button.disabled).toBe(false);
  });

  it('selection chips render for a selected entity and Keep these protects it', () => {
    useApp.setState({ selection: ['gallery'] });
    render(<PromptPanel />);
    expect(screen.getByText('gallery ✕')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep these' }));
    expect(useApp.getState().protectedIds).toEqual(['gallery']);
    expect(useApp.getState().repair.status).toBe('idle');
  });
});
