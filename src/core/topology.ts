import { BOUNDS, CARDINALS, type Cardinal, type Door, type Level, type LevelModule } from '../../shared/schema';
import { CATALOG_VERSION, GEOMETRY, dirDelta, opposite, portElevation, verticalSpan } from './catalog';
import { revisionId } from './serialize';

/**
 * Geometry-derived connectivity and edge obstacles (§3, §4.2). Two modules
 * connect only where world-space ports coincide, face one another, and share
 * a port elevation. Rendering consumes the same catalog used here.
 */

export interface TopologyEdge {
  aId: string;
  bId: string;
  /** Direction of travel from aId to bId. */
  direction: Cardinal;
  portElevation: number;
  doorId?: string;
}

export interface CompiledLevel {
  level: Level;
  revisionId: string;
  catalogVersion: string;
  moduleById: Map<string, LevelModule>;
  edges: TopologyEdge[];
  /** Every edge touching a module, keyed by module id. */
  edgesByModule: Map<string, TopologyEdge[]>;
  /** Key/switch id → bit index in the state masks; ids sorted lexicographically. */
  keyBit: Map<string, number>;
  switchBit: Map<string, number>;
  doorById: Map<string, Door>;
  keyByModule: Map<string, string>;
  switchByModule: Map<string, string>;
  spawn: string;
  goal: string;
}

/** Canonical identity of the shared edge between two modules. */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function groupByCell(modules: LevelModule[]): Map<string, LevelModule[]> {
  const byCell = new Map<string, LevelModule[]>();
  for (const m of modules) {
    const cell = `${m.x},${m.z}`;
    const list = byCell.get(cell);
    if (list) list.push(m);
    else byCell.set(cell, [m]);
  }
  return byCell;
}

/**
 * All connection edges, deterministic. Each edge is created once, from the
 * lexicographically smaller module, in N/E/S/W scan order. Unmatched ports
 * are legal and simply produce no edge.
 */
export function computeEdges(level: Level): TopologyEdge[] {
  const modules = [...level.modules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byCell = groupByCell(modules);
  const edges: TopologyEdge[] = [];
  for (const m of modules) {
    for (const dir of CARDINALS) {
      const elevation = portElevation(m, dir);
      if (elevation === null) continue;
      const { dx, dz } = dirDelta(dir);
      const nx = m.x + dx;
      const nz = m.z + dz;
      if (nx < 0 || nx > BOUNDS.maxX || nz < 0 || nz > BOUNDS.maxZ) continue;
      for (const n of byCell.get(`${nx},${nz}`) ?? []) {
        // The edge is created from the smaller id; the larger id skips it.
        if (n.id <= m.id) continue;
        if (portElevation(n, opposite(dir)) === elevation) {
          edges.push({ aId: m.id, bId: n.id, direction: dir, portElevation: elevation });
        }
      }
    }
  }
  return edges;
}

/** Overlap and headroom validation (§4.2). Conservative volumes by design. */
export function validateGeometry(level: Level): string[] {
  const errors: string[] = [];
  for (const [cell, mods] of groupByCell(level.modules)) {
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const a = mods[i]!;
        const b = mods[j]!;
        const [aLo, aHi] = verticalSpan(a);
        const [bLo, bHi] = verticalSpan(b);
        if (aLo < bHi && bLo < aHi) {
          errors.push(`Modules "${a.id}" and "${b.id}" overlap at cell (${cell}).`);
          continue;
        }
        const [lowerTop, upperBottom] = aHi <= bLo ? [aHi, bLo] : [bHi, aLo];
        const gap = upperBottom - lowerTop;
        if (gap < GEOMETRY.playerHeightCm) {
          errors.push(
            `Insufficient headroom at cell (${cell}): only ${gap} cm above the lower module (need ${GEOMETRY.playerHeightCm} cm).`,
          );
        }
      }
    }
  }
  return errors;
}

/** Compile a validated level into the immutable form used by movement. */
export function compileLevel(level: Level): CompiledLevel {
  const moduleById = new Map(level.modules.map((m) => [m.id, m] as const));
  const edges = computeEdges(level);

  const edgesByModule = new Map<string, TopologyEdge[]>();
  const attach = (id: string, edge: TopologyEdge) => {
    const list = edgesByModule.get(id);
    if (list) list.push(edge);
    else edgesByModule.set(id, [edge]);
  };
  for (const edge of edges) {
    attach(edge.aId, edge);
    attach(edge.bId, edge);
  }

  const doorById = new Map(level.doors.map((d) => [d.id, d] as const));
  const edgeByKey = new Map(edges.map((e) => [edgeKey(e.aId, e.bId), e] as const));
  for (const door of level.doors) {
    const edge = edgeByKey.get(edgeKey(door.a, door.b));
    if (edge) edge.doorId = door.id;
  }

  const keyBit = new Map<string, number>();
  level.keys.map((k) => k.id).sort().forEach((id, index) => keyBit.set(id, 1 << index));
  const switchBit = new Map<string, number>();
  level.switches.map((s) => s.id).sort().forEach((id, index) => switchBit.set(id, 1 << index));

  const keyByModule = new Map(level.keys.map((k) => [k.moduleId, k.id] as const));
  const switchByModule = new Map(level.switches.map((s) => [s.moduleId, s.id] as const));

  return {
    level,
    revisionId: revisionId(level),
    catalogVersion: CATALOG_VERSION,
    moduleById,
    edges,
    edgesByModule,
    keyBit,
    switchBit,
    doorById,
    keyByModule,
    switchByModule,
    spawn: level.spawn,
    goal: level.goal,
  };
}

/** The edge leaving `moduleId` toward `dir`, if one exists. */
export function neighbor(
  compiled: CompiledLevel,
  moduleId: string,
  dir: Cardinal,
): { edge: TopologyEdge; toId: string } | null {
  for (const edge of compiled.edgesByModule.get(moduleId) ?? []) {
    if (edge.aId === moduleId && edge.direction === dir) return { edge, toId: edge.bId };
    if (edge.bId === moduleId && opposite(edge.direction) === dir) return { edge, toId: edge.aId };
  }
  return null;
}
