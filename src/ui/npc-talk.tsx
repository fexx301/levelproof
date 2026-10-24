import { useMemo } from 'react';
import { npcOkResponseSchema } from '../../shared/api.js';
import type { Level } from '../../shared/schema.js';
import { npcFacts, npcNear, plainNpcLine } from '../core/npc.js';
import { compileLevel } from '../core/topology.js';
import { actorBridge } from '../render/bridge.js';
import { playSound } from '../render/sound.js';
import { useApp } from '../state/store.js';

/** The server's voice call is capped at 30 s; past this the line stays plain. */
const VOICE_WATCHDOG_MS = 35_000;

const nameOf = (id: string): string => id.replace(/-/g, ' ');

/**
 * Talk to the character beside the player (T key or the button). The engine
 * answers first — its plain line shows at once and the hint trail is drawn,
 * counted like any hint — then the AI voices the same facts in character.
 * The server recomputes those facts and checks the line; if it cannot, the
 * plain line stays, labeled.
 */
export async function talkToNpc(level: Level): Promise<void> {
  const player = actorBridge.player();
  if (player === null) return;
  const { state, visited } = player.standing();
  const npc = npcNear(level, state.moduleId);
  if (npc === null) return;
  const compiled = compileLevel(level);
  const plain = plainNpcLine(npcFacts(compiled, npc, state, new Set(visited)));
  const at = state.moduleId;
  player.hint();
  playSound('hint');
  useApp.setState({ npcTalk: { npcId: npc.id, at, plain, voiced: null, status: 'asking' } });
  const current = () => {
    const talk = useApp.getState().npcTalk;
    return talk !== null && talk.npcId === npc.id && talk.at === at ? talk : null;
  };
  const held = (bits: Map<string, number>, mask: number): string[] => [...bits.entries()].filter(([, bit]) => (mask & bit) !== 0).map(([id]) => id);
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), VOICE_WATCHDOG_MS);
  try {
    const response = await fetch('/api/npc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        npcId: npc.id,
        state: { moduleId: state.moduleId, keys: held(compiled.keyBit, state.keyMask), switches: held(compiled.switchBit, state.switchMask), phase: state.phase },
        visited,
      }),
      signal: controller.signal,
    });
    const parsed = response.ok ? npcOkResponseSchema.safeParse(await response.json()) : null;
    const talk = current();
    if (talk === null) return;
    if (parsed?.success !== true) {
      useApp.setState({ npcTalk: { ...talk, status: 'plain' } });
      return;
    }
    const { line, cached, attempts, totalCostUsd } = parsed.data;
    useApp.setState({ npcTalk: { ...talk, voiced: line, status: 'voiced', meta: { cached, model: attempts.at(-1)?.model ?? 'cache', totalCostUsd } } });
  } catch {
    const talk = current();
    if (talk !== null) useApp.setState({ npcTalk: { ...talk, status: 'plain' } });
  } finally {
    clearTimeout(watchdog);
  }
}

export function NpcTalkPanel({ level }: { level: Level }) {
  const at = useApp((s) => s.play.at);
  const atGoal = useApp((s) => s.play.atGoal);
  const talk = useApp((s) => s.npcTalk);
  const npc = useMemo(() => (at ? npcNear(level, at) : null), [level, at]);
  if (npc === null || atGoal) return null;
  const name = nameOf(npc.id);
  const shown = talk !== null && talk.npcId === npc.id && talk.at === at ? talk : null;
  return (
    <div className="npc-talk">
      {shown === null ? (
        <button type="button" className="npc-talk-button" onClick={() => void talkToNpc(level)} aria-keyshortcuts="T">
          Talk to the {name} (T)
        </button>
      ) : (
        <figure className="npc-talk-line" aria-live="polite">
          <blockquote>{shown.voiced ?? shown.plain}</blockquote>
          <figcaption>
            — the {name}
            {shown.status === 'asking' && ' · finding the words…'}
            {shown.status === 'voiced' && ` · AI voice of the engine’s next step (${shown.meta?.cached ? 'cached' : 'fresh'})`}
            {shown.status === 'plain' && ' · the engine’s own words (AI voice unavailable)'}
          </figcaption>
        </figure>
      )}
    </div>
  );
}
