import { ENVIRONMENTS, KEY_LOOKS, LIGHTINGS, PROP_KINDS, THEME_KEYS } from './schema.js';

/**
 * Cosmetic vocabulary normalization. Models describe scenery in the author's
 * words ("a lamp", "a jungle", "at sunset"); these fields never affect play,
 * so near-misses map to the closest supported value and unknown decorations
 * are dropped instead of costing a 20-second retry. Gameplay fields are never
 * touched here: they stay strictly validated.
 */

const PROP_ALIASES: Record<string, (typeof PROP_KINDS)[number]> = {
  lamp: 'lantern', lamppost: 'lantern', 'lamp-post': 'lantern', streetlight: 'lantern', light: 'lantern',
  bonfire: 'campfire', fire: 'campfire', firepit: 'campfire', 'fire-pit': 'campfire',
  candle: 'candles', candelabra: 'candles',
  column: 'pillar', obelisk: 'pillar', monolith: 'pillar', 'standing-stone': 'pillar',
  tomb: 'gravestone', grave: 'gravestone', tombstone: 'gravestone', headstone: 'gravestone', coffin: 'gravestone',
  idol: 'statue', knight: 'statue', guard: 'statue', guardian: 'statue', golem: 'statue', gargoyle: 'statue', ghost: 'statue', sculpture: 'statue',
  wyvern: 'dragon', drake: 'dragon', serpent: 'dragon', monster: 'dragon',
  treasure: 'chest', 'treasure-chest': 'chest', gold: 'chest', coffer: 'chest',
  computer: 'console', terminal: 'console', panel: 'console', 'control-panel': 'console',
  radio: 'antenna', mast: 'antenna', tower: 'antenna', dish: 'antenna', beacon: 'antenna',
  boulder: 'rock', stone: 'rock', stones: 'rock', rocks: 'rock',
  gem: 'crystal', crystals: 'crystal', shard: 'crystal',
  shrub: 'bush', hedge: 'bush', bushes: 'bush', fern: 'bush',
  oak: 'tree', trees: 'tree', willow: 'tree', 'tree-oak': 'tree',
  fir: 'pine', spruce: 'pine', conifer: 'pine', 'pine-tree': 'pine',
  'dead-trees': 'dead-tree', deadtree: 'dead-tree', 'bare-tree': 'dead-tree', 'twisted-tree': 'dead-tree',
  'palm-tree': 'palm',
  mushrooms: 'mushroom', toadstool: 'mushroom', fungus: 'mushroom',
  pool: 'water', pond: 'water', river: 'water', moat: 'water', lake: 'water', stream: 'water',
  magma: 'lava', 'lava-pool': 'lava',
  flag: 'banner', pennant: 'banner', tapestry: 'banner',
  crate: 'barrel', crates: 'barrel', box: 'barrel', barrels: 'barrel',
  well: 'fountain',
  gate: 'portal', rift: 'portal', 'magic-portal': 'portal',
  ruins: 'ruin', rubble: 'ruin', 'broken-pillar': 'ruin',
  sconce: 'torch', 'wall-torch': 'torch', torches: 'torch',
  seat: 'throne', chair: 'throne',
};

const LOOK_ALIASES: Record<string, (typeof KEY_LOOKS)[number]> = {
  lamp: 'lantern', candle: 'torch', flame: 'torch', fire: 'torch',
  crystal: 'gem', jewel: 'gem', ruby: 'gem', emerald: 'gem', sapphire: 'gem', diamond: 'gem', stone: 'gem', relic: 'gem', idol: 'gem', rune: 'gem',
  sphere: 'orb', pearl: 'orb', globe: 'orb',
  tiara: 'crown', circlet: 'crown',
  book: 'scroll', map: 'scroll', letter: 'scroll', tome: 'scroll',
  card: 'keycard', pass: 'keycard', badge: 'keycard', chip: 'keycard',
  necklace: 'amulet', pendant: 'amulet', talisman: 'amulet', medallion: 'amulet', coin: 'amulet', ring: 'amulet',
};

const ENVIRONMENT_ALIASES: Record<string, (typeof ENVIRONMENTS)[number]> = {
  jungle: 'forest', woods: 'forest', woodland: 'forest', grove: 'forest',
  graveyard: 'swamp', bog: 'swamp', marsh: 'swamp', bayou: 'swamp',
  mountain: 'snow', ice: 'snow', tundra: 'snow', arctic: 'snow', glacier: 'snow', winter: 'snow',
  beach: 'sea', island: 'sea', ocean: 'sea', harbor: 'sea', coast: 'sea', lake: 'sea',
  lava: 'volcanic', volcano: 'volcanic', hell: 'volcanic',
  cave: 'cavern', dungeon: 'cavern', underground: 'cavern', mine: 'cavern', crypt: 'cavern',
  sand: 'desert', dunes: 'desert', canyon: 'desert',
  grassland: 'meadow', field: 'meadow', plains: 'meadow', garden: 'meadow', countryside: 'meadow',
  station: 'space', orbit: 'space', asteroid: 'space', moon: 'space',
  cyberpunk: 'city', urban: 'city', town: 'city', street: 'city', metropolis: 'city',
  none: 'void', empty: 'void',
};

const LIGHTING_ALIASES: Record<string, (typeof LIGHTINGS)[number]> = {
  sunset: 'dusk', dawn: 'dusk', twilight: 'dusk', evening: 'dusk', sunrise: 'dusk', 'golden-hour': 'dusk',
  noon: 'day', morning: 'day', midday: 'day', afternoon: 'day', daylight: 'day', sunny: 'day',
  midnight: 'night', dark: 'night', moonlight: 'night', moonlit: 'night',
};

function slug(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : null;
}

function resolve<T extends string>(value: unknown, allowed: readonly T[], aliases: Record<string, T>): T | null {
  const key = slug(value);
  if (key === null) return null;
  if ((allowed as readonly string[]).includes(key)) return key as T;
  if (aliases[key] !== undefined) return aliases[key]!;
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  if ((allowed as readonly string[]).includes(singular)) return singular as T;
  return aliases[singular] ?? null;
}

function normalizeOperation(operation: unknown): unknown | null {
  if (operation === null || typeof operation !== 'object') return operation;
  const op = { ...(operation as Record<string, unknown>) };
  switch (op.kind) {
    case 'addItem': {
      if (op.look === undefined) return op;
      const look = resolve(op.look, KEY_LOOKS, LOOK_ALIASES);
      if (look === null || op.itemType !== 'key') delete op.look;
      else op.look = look;
      return op;
    }
    case 'setKeyLook': {
      const look = resolve(op.look, KEY_LOOKS, LOOK_ALIASES);
      return look === null ? null : { ...op, look };
    }
    case 'addProp': {
      const prop = resolve(op.prop, PROP_KINDS, PROP_ALIASES);
      return prop === null ? null : { ...op, prop };
    }
    case 'setScenery': {
      for (const [field, allowed, aliases] of [
        ['environment', ENVIRONMENTS, ENVIRONMENT_ALIASES],
        ['lighting', LIGHTINGS, LIGHTING_ALIASES],
        ['architecture', THEME_KEYS, {}],
      ] as const) {
        if (op[field] === undefined) continue;
        const value = resolve(op[field], allowed, aliases as Record<string, string>);
        if (value === null) delete op[field];
        else op[field] = value;
      }
      return op.environment === undefined && op.lighting === undefined && op.architecture === undefined ? null : op;
    }
    default:
      return op;
  }
}

/** Normalize the cosmetic operations inside a parsed compile payload. */
export function normalizeSceneryVocabulary(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.operations)) return payload;
  return {
    ...record,
    operations: record.operations.map(normalizeOperation).filter((operation) => operation !== null),
  };
}
