import { afterEach, describe, expect, it, vi } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import {
  SAVES_KEY,
  normalizeSavedScenes,
  persistSavedScenes,
  prependSavedScene,
  readSavedScenes,
  safeBrowserStorage,
  type StorageLike,
} from '../src/state/persistence';

function memoryStorage(initial: string | null = null): StorageLike & { value: string | null } {
  let value = initial;
  return {
    get value() {
      return value;
    },
    getItem() {
      return value;
    },
    setItem(_key, next) {
      value = next;
    },
  };
}

function failingStorage(): StorageLike {
  return {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('quota');
    },
  };
}

function failingLevel() {
  const level = structuredClone(baselineLevel);
  level.goal = 'gallery';
  return level;
}

describe('versioned legacy save persistence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not report success when browser storage is missing or its getter throws', () => {
    const record = normalizeSavedScenes([{ id: 'accepted', name: 'Accepted', savedAt: 1, level: baselineLevel }]);
    expect(persistSavedScenes(undefined, record)).toMatchObject({ ok: false });
    const restrictedWindow = Object.defineProperty({}, 'localStorage', {
      get() { throw new Error('blocked by browser policy'); },
    });
    vi.stubGlobal('window', restrictedWindow);
    expect(safeBrowserStorage()).toBeUndefined();
  });

  it('keeps accepted, editable draft, and malformed entries visible', () => {
    const rawAccepted = { id: 'accepted-old', name: 'Accepted old', savedAt: 1, level: baselineLevel };
    const rawDraft = { id: 'draft-old', name: 'Draft old', savedAt: 2, level: failingLevel() };
    const rawMalformed = { id: 'broken-old', name: 'Broken old', savedAt: 3, level: { nope: true } };
    const records = normalizeSavedScenes([rawAccepted, rawDraft, rawMalformed]);

    expect(records.map((record) => record.status)).toEqual(['accepted', 'draft', 'unavailable']);
    expect(records[1]?.recordKey).toBe('draft-old');
    if (records[2]?.status === 'unavailable') expect(records[2].error).toContain('malformed');

    const storage = memoryStorage();
    expect(persistSavedScenes(storage, records).ok).toBe(true);
    const persisted = JSON.parse(storage.value ?? '') as { version: number; entries: unknown[] };
    expect(persisted.version).toBe(2);
    expect(persisted.entries).toEqual([rawAccepted, rawDraft, rawMalformed]);
  });

  it('gives duplicate legacy ids unique internal keys without changing raw payloads', () => {
    const first = { id: 'same-id', name: 'First', savedAt: 1, level: baselineLevel };
    const second = { id: 'same-id', name: 'Second', savedAt: 2, level: baselineLevel };
    const records = normalizeSavedScenes([first, second]);

    expect(records[0]?.recordKey).toBe('same-id');
    expect(records[1]?.recordKey).not.toBe(records[0]?.recordKey);
    const storage = memoryStorage();
    expect(persistSavedScenes(storage, records).ok).toBe(true);
    const persisted = JSON.parse(storage.value ?? '') as { entries: unknown[] };
    expect(persisted.entries).toEqual([first, second]);
  });

  it('exposes corrupt root data as a removable entry instead of silently resetting it', () => {
    const storage = memoryStorage('{not-json');
    const records = readSavedScenes(storage);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('unavailable');
    if (records[0]?.status === 'unavailable') expect(records[0].rootCorrupt).toBe(true);
    expect(persistSavedScenes(storage, records).ok).toBe(false);

    expect(persistSavedScenes(storage, []).ok).toBe(true);
    expect(storage.getItem(SAVES_KEY)).toContain('"version":2');
  });

  it('never prunes older accepted, draft, or unavailable legacy entries on save', () => {
    const accepted = Array.from({ length: 24 }, (_, index) => ({
      id: `accepted-${index}`,
      name: `Accepted ${index}`,
      savedAt: index,
      level: baselineLevel,
    }));
    const records = normalizeSavedScenes([
      ...accepted,
      { id: 'old-draft', name: 'Old draft', savedAt: 100, level: failingLevel() },
      { id: 'old-broken', name: 'Old broken', savedAt: 101, level: { nope: true } },
    ]);
    const next = normalizeSavedScenes([{ id: 'new', name: 'New', savedAt: 200, level: baselineLevel }])[0]!;
    if (next.status !== 'accepted') throw new Error('baseline fixture should be accepted');

    const kept = prependSavedScene(records, next);
    expect(kept.filter((record) => record.status === 'accepted')).toHaveLength(25);
    expect(kept.find((record) => record.recordKey === 'accepted-23')?.status).toBe('accepted');
    expect(kept.find((record) => record.recordKey === 'old-draft')?.status).toBe('draft');
    expect(kept.find((record) => record.recordKey === 'old-broken')?.status).toBe('unavailable');
  });

  it('returns a recoverable storage error without hiding the in-memory records', () => {
    const records = normalizeSavedScenes([{ id: 'accepted', name: 'Accepted', savedAt: 1, level: baselineLevel }]);
    const persisted = persistSavedScenes(failingStorage(), records);
    expect(persisted.ok).toBe(false);
    if (!persisted.ok) expect(persisted.error).toContain('current session is unchanged');
  });
});
