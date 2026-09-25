// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { SceneObjectPicker } from '../src/ui/scene-object-picker';
import { useApp } from '../src/state/store';

afterEach(cleanup);

beforeEach(() => {
  useApp.setState({ selection: [], protectedIds: [], error: null });
});

describe('accessible scene object picker', () => {
  it('offers keyboard-addressable named entities with a selected state', () => {
    render(<SceneObjectPicker level={baselineLevel} />);
    fireEvent.click(screen.getByText('Select an object by name'));
    const gallery = screen.getByRole('button', { name: /upper foyer.*gallery.*floor/i });
    expect(gallery.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(gallery);
    expect(gallery.getAttribute('aria-pressed')).toBe('true');
    expect(useApp.getState().selection).toContain('gallery');
  });

  it('disables unselected entities after the API-safe selection limit', () => {
    useApp.setState({ selection: Array.from({ length: 8 }, (_, index) => `id-${index}`) });
    render(<SceneObjectPicker level={baselineLevel} />);
    fireEvent.click(screen.getByText('Select an object by name'));
    expect(screen.getByRole('button', { name: /upper foyer.*gallery.*floor/i }).hasAttribute('disabled')).toBe(true);
  });
});
