import { themeKeySchema, type ThemeKey } from '../../shared/api.js';
import { levelSchema, type Level } from '../../shared/schema.js';
import { verify } from '../core/verifier.js';

/** Versioned, backwards-compatible local save adapter. */
export const SAVES_KEY = 'levelproof:saves';
export const SAVES_VERSION = 2;
export const MAX_ACCEPTED_SAVES = 20;

export type SavedSceneStatus = 'accepted' | 'draft' | 'unavailable';

interface SavedSceneBase {
  /** Internal identity. It is unique even when legacy ids collide or are malformed. */
  recordKey: string;
  /** Original id when one was present; retained for recoverability. */
  id: string;
  name: string;
  savedAt: number;
  theme: ThemeKey | null;
  promptHistory: string[];
  status: SavedSceneStatus;
  /** Exact legacy payload, kept so a later save cannot erase hidden data. */
  raw?: unknown;
}

export interface AcceptedSavedScene extends SavedSceneBase {
  status: 'accepted';
  level: Level;
}

export interface DraftSavedScene extends SavedSceneBase {
  status: 'draft';
  level: Level;
}

export interface UnavailableSavedScene extends SavedSceneBase {
  status: 'unavailable';
  error: string;
  rootCorrupt?: boolean;
}

export type SavedScene = AcceptedSavedScene | DraftSavedScene | UnavailableSavedScene;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PersistResult = { ok: true } | { ok: false; error: string };

interface LegacyObject {
  id?: unknown;
  name?: unknown;
  savedAt?: unknown;
  level?: unknown;
  theme?: unknown;
  promptHistory?: unknown;
  error?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function uniqueRecordKey(preferred: string, index: number, used: Set<string>): string {
  const base = preferred.trim() || `legacy-${index + 1}`;
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}--${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

function metadata(entry: unknown, index: number, used: Set<string>): Omit<SavedSceneBase, 'status' | 'raw'> {
  const object = isObject(entry) ? (entry as LegacyObject) : {};
  const id = typeof object.id === 'string' && object.id.trim() !== '' ? object.id : `legacy-${index + 1}`;
  const recordKey = uniqueRecordKey(id, index, used);
  const name = typeof object.name === 'string' && object.name.trim() !== '' ? object.name : `Legacy entry ${index + 1}`;
  const savedAt = typeof object.savedAt === 'number' && Number.isFinite(object.savedAt) ? object.savedAt : 0;
  const parsedTheme = themeKeySchema.safeParse(object.theme ?? null);
  const promptHistory = Array.isArray(object.promptHistory)
    ? object.promptHistory.filter((prompt): prompt is string => typeof prompt === 'string').slice(-6)
    : [];
  return { recordKey, id, name, savedAt, theme: parsedTheme.success ? parsedTheme.data : null, promptHistory };
}

function invalidEntry(entry: unknown, index: number, used: Set<string>, error: string): UnavailableSavedScene {
  const base = metadata(entry, index, used);
  return { ...base, status: 'unavailable', error, raw: entry };
}

/**
 * Classify every entry instead of filtering. Schema-valid but failing
 * checkpoints remain editable drafts; malformed or semantically invalid
 * payloads remain visible as recoverable unavailable entries.
 */
export function normalizeSavedScenes(value: unknown): SavedScene[] {
  if (!Array.isArray(value)) {
    return [
      {
        recordKey: 'legacy-root',
        id: 'legacy-root',
        name: 'Unreadable local saves',
        savedAt: 0,
        theme: null,
        promptHistory: [],
        status: 'unavailable',
        rootCorrupt: true,
        error: 'The saved-puzzle file is malformed. Remove this entry to reset local saves.',
      },
    ];
  }

  const used = new Set<string>();
  return value.map((entry, index) => {
    if (!isObject(entry) || !('level' in entry)) {
      const object = isObject(entry) ? (entry as LegacyObject) : {};
      const storedError = typeof object.error === 'string' ? object.error : null;
      return invalidEntry(entry, index, used, storedError ?? 'This saved entry has no readable level payload.');
    }

    const base = metadata(entry, index, used);
    const parsedLevel = levelSchema.safeParse((entry as LegacyObject).level);
    if (!parsedLevel.success) {
      return {
        ...base,
        status: 'unavailable',
        error: 'This saved entry is malformed and cannot be rendered. Remove it to clear the entry.',
        raw: entry,
      } satisfies UnavailableSavedScene;
    }

    const report = verify(parsedLevel.data);
    if (!report.valid) {
      return {
        ...base,
        status: 'unavailable',
        error: `This saved entry is structurally invalid: ${report.invalidReasons[0] ?? 'the level failed validation.'}`,
        raw: entry,
      } satisfies UnavailableSavedScene;
    }
    if (!report.accepted) {
      return { ...base, status: 'draft', level: parsedLevel.data, raw: entry } satisfies DraftSavedScene;
    }
    return { ...base, status: 'accepted', level: parsedLevel.data, raw: entry } satisfies AcceptedSavedScene;
  });
}

export function readSavedScenes(storage: StorageLike | undefined): SavedScene[] {
  if (storage === undefined) return [];
  try {
    const raw = storage.getItem(SAVES_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeSavedScenes(parsed);
    if (isObject(parsed) && Array.isArray(parsed.entries)) {
      return normalizeSavedScenes(parsed.entries);
    }
    return normalizeSavedScenes(parsed);
  } catch {
    return [
      {
        recordKey: 'legacy-root',
        id: 'legacy-root',
        name: 'Unreadable local saves',
        savedAt: 0,
        theme: null,
        promptHistory: [],
        status: 'unavailable',
        rootCorrupt: true,
        error: 'The saved-puzzle file is malformed. Remove this entry to reset local saves.',
      },
    ];
  }
}

function serialize(record: SavedScene): unknown {
  if (record.raw !== undefined) return record.raw;
  if (record.status === 'unavailable') {
    return {
      id: record.id,
      name: record.name,
      savedAt: record.savedAt,
      error: record.error,
    };
  }
  return {
    id: record.id,
    name: record.name,
    savedAt: record.savedAt,
    level: record.level,
    ...(record.theme !== null ? { theme: record.theme } : {}),
    ...(record.promptHistory.length > 0 ? { promptHistory: record.promptHistory } : {}),
  };
}

export function persistSavedScenes(storage: StorageLike | undefined, records: SavedScene[]): PersistResult {
  if (storage === undefined) return { ok: true };
  if (records.some((record) => record.status === 'unavailable' && record.rootCorrupt)) {
    return { ok: false, error: 'Local saves are unreadable. Remove the “Unreadable local saves” entry before saving.' };
  }
  try {
    storage.setItem(SAVES_KEY, JSON.stringify({ version: SAVES_VERSION, entries: records.map(serialize) }));
    return { ok: true };
  } catch {
    return { ok: false, error: 'Local storage is unavailable or full. Your current session is unchanged.' };
  }
}

/** Keep every draft/unavailable legacy entry while capping accepted checkpoints. */
export function prependSavedScene(records: SavedScene[], next: AcceptedSavedScene): SavedScene[] {
  const combined = [next, ...records];
  let acceptedSeen = 0;
  const kept: SavedScene[] = [];
  for (const record of combined) {
    if (record.status === 'accepted') {
      acceptedSeen += 1;
      if (acceptedSeen > MAX_ACCEPTED_SAVES) continue;
    }
    kept.push(record);
  }
  return kept;
}

export function savedSceneOptionLabel(record: SavedScene): string {
  if (record.status === 'accepted') return record.name;
  if (record.status === 'draft') return `${record.name} · Draft`;
  return `${record.name} · Draft unavailable`;
}
