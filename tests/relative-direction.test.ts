import { describe, expect, it } from 'vitest';
import { relativeCardinal } from '../src/ui/relative-direction';

describe('camera-relative play controls', () => {
  it('maps forward, back, left, and right onto the grid for every facing', () => {
    expect(['forward', 'right', 'back', 'left'].map((intent) => relativeCardinal('N', intent as never))).toEqual(['N', 'E', 'S', 'W']);
    expect(['forward', 'right', 'back', 'left'].map((intent) => relativeCardinal('E', intent as never))).toEqual(['E', 'S', 'W', 'N']);
    expect(['forward', 'right', 'back', 'left'].map((intent) => relativeCardinal('S', intent as never))).toEqual(['S', 'W', 'N', 'E']);
    expect(['forward', 'right', 'back', 'left'].map((intent) => relativeCardinal('W', intent as never))).toEqual(['W', 'N', 'E', 'S']);
  });
});
