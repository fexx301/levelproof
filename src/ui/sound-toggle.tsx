import { useEffect, useState } from 'react';
import { onSoundMuted, setSoundMuted, soundMuted, unlockSound } from '../render/sound.js';

/**
 * Sound on/off over the viewport. Audio can only start after a user gesture,
 * so the first click or key press anywhere unlocks it.
 */
export function SoundToggle() {
  const [muted, setMuted] = useState(soundMuted);
  useEffect(() => onSoundMuted(setMuted), []);
  useEffect(() => {
    const unlock = () => unlockSound();
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);
  return (
    <button
      type="button"
      className="viewport-home viewport-sound"
      aria-pressed={!muted}
      aria-label={muted ? 'Sound off — turn on' : 'Sound on — turn off'}
      title={muted ? 'Turn sound on' : 'Turn sound off'}
      onClick={() => {
        unlockSound();
        setSoundMuted(!muted);
      }}
    >
      {muted ? 'Sound off' : 'Sound on'}
    </button>
  );
}
