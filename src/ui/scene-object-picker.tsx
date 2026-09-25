import type { Level } from '../../shared/schema.js';
import { useApp } from '../state/store.js';

interface SceneEntity {
  id: string;
  label: string;
  kind: 'floor' | 'bridge' | 'ramp' | 'key' | 'switch' | 'door';
}

function entitiesIn(level: Level): SceneEntity[] {
  const entities: SceneEntity[] = [
    ...level.modules.map((module) => ({
      id: module.id,
      label: module.label ?? module.id,
      kind: module.template === 'flat' ? 'floor' as const : module.template,
    })),
    ...level.keys.map((key) => ({ id: key.id, label: key.id, kind: 'key' as const })),
    ...level.switches.map((item) => ({ id: item.id, label: item.id, kind: 'switch' as const })),
    ...level.doors.map((door) => ({ id: door.id, label: door.id, kind: 'door' as const })),
  ];
  return entities.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

/** Keyboard-accessible equivalent of picking a rendered mesh. */
export function SceneObjectPicker({ level }: { level: Level }) {
  const selection = useApp((state) => state.selection);
  const toggleSelect = useApp((state) => state.toggleSelect);
  const entities = entitiesIn(level);

  return (
    <details className="scene-object-picker">
      <summary>Select an object by name</summary>
      <p className="panel-note">Choose up to 8 floors, keys, switches, or doors for your next prompt.</p>
      <div className="scene-object-list" role="group" aria-label="Scene objects">
        {entities.map((entity) => {
          const selected = selection.includes(entity.id);
          return (
            <button
              key={entity.id}
              type="button"
              aria-pressed={selected}
              disabled={!selected && selection.length >= 8}
              onClick={() => toggleSelect(entity.id)}
            >
              <span>{entity.label}</span>
              <span className="scene-object-id">{entity.id}</span>
              <span className="scene-object-kind">{entity.kind}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
