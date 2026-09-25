/**
 * Game sound, synthesized with Web Audio — no recorded samples, so no asset
 * licences. Everything is short, quiet, and optional: nothing plays until
 * the page has had a user gesture (browser autoplay rules), and the mute
 * choice is remembered per browser. Outside a browser every call is a no-op.
 */

export type SoundCue =
  | 'step'
  | 'ghostStep'
  | 'key'
  | 'switch'
  | 'doorOpen'
  | 'doorSeal'
  | 'win'
  | 'fail'
  | 'hint';

const MUTE_KEY = 'levelproof:sound-muted';
const MASTER_VOLUME = 0.5;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = readMuted();
const listeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Create or resume the audio context; call from a user gesture. */
export function unlockSound(): void {
  if (typeof window === 'undefined') return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return;
  try {
    if (context === null) {
      context = new Ctor();
      master = context.createGain();
      master.gain.value = muted ? 0 : MASTER_VOLUME;
      master.connect(context.destination);
      noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (context.state === 'suspended') void context.resume();
  } catch {
    context = null;
  }
}

export function soundMuted(): boolean {
  return muted;
}

export function setSoundMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    // Storage may be unavailable; the choice still holds for this page.
  }
  if (master !== null && context !== null) master.gain.setTargetAtTime(next ? 0 : MASTER_VOLUME, context.currentTime, 0.02);
  for (const listener of listeners) listener(next);
}

export function onSoundMuted(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tone(
  ctx: AudioContext,
  out: AudioNode,
  at: number,
  { type = 'sine', from, to = from, duration, peak, attack = 0.005 }: {
    type?: OscillatorType;
    from: number;
    to?: number;
    duration: number;
    peak: number;
    attack?: number;
  },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + duration);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function burst(
  ctx: AudioContext,
  out: AudioNode,
  at: number,
  { filter, frequency, q = 1, duration, peak, sweepTo }: {
    filter: BiquadFilterType;
    frequency: number;
    q?: number;
    duration: number;
    peak: number;
    sweepTo?: number;
  },
): void {
  if (noise === null) return;
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.playbackRate.value = 0.8 + Math.random() * 0.4;
  const biquad = ctx.createBiquadFilter();
  biquad.type = filter;
  biquad.frequency.setValueAtTime(frequency, at);
  if (sweepTo !== undefined) biquad.frequency.exponentialRampToValueAtTime(sweepTo, at + duration);
  biquad.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  source.connect(biquad).connect(gain).connect(out);
  source.start(at, Math.random() * 0.5);
  source.stop(at + duration + 0.02);
}

/** Play one cue now (silently skipped when muted or before a gesture). */
export function playSound(cue: SoundCue): void {
  if (muted || context === null || master === null || context.state !== 'running') return;
  const ctx = context;
  const out = master;
  const now = ctx.currentTime + 0.005;
  switch (cue) {
    case 'step':
    case 'ghostStep': {
      const level = cue === 'step' ? 0.22 : 0.07;
      burst(ctx, out, now, { filter: 'bandpass', frequency: 700 + Math.random() * 350, q: 1.4, duration: 0.07, peak: level });
      tone(ctx, out, now, { from: 110 + Math.random() * 20, to: 70, duration: 0.06, peak: level * 0.5 });
      break;
    }
    case 'key':
      [988, 1319, 1976].forEach((f, i) => tone(ctx, out, now + i * 0.07, { type: 'triangle', from: f, duration: 0.22, peak: 0.16 }));
      break;
    case 'switch':
      burst(ctx, out, now, { filter: 'highpass', frequency: 2400, duration: 0.03, peak: 0.25 });
      tone(ctx, out, now + 0.02, { type: 'square', from: 180, to: 90, duration: 0.12, peak: 0.08 });
      break;
    case 'doorOpen':
      burst(ctx, out, now, { filter: 'lowpass', frequency: 300, sweepTo: 1400, duration: 0.45, peak: 0.12 });
      tone(ctx, out, now, { type: 'triangle', from: 220, to: 330, duration: 0.35, peak: 0.06 });
      break;
    case 'doorSeal':
      burst(ctx, out, now, { filter: 'lowpass', frequency: 1600, sweepTo: 180, duration: 0.35, peak: 0.3 });
      tone(ctx, out, now, { from: 90, to: 38, duration: 0.5, peak: 0.45, attack: 0.003 });
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(ctx, out, now + i * 0.11, { type: 'triangle', from: f, duration: 0.5, peak: 0.14 }));
      tone(ctx, out, now + 0.44, { type: 'sine', from: 1568, duration: 0.7, peak: 0.06 });
      break;
    case 'fail':
      tone(ctx, out, now, { type: 'triangle', from: 392, to: 370, duration: 0.3, peak: 0.14 });
      tone(ctx, out, now + 0.26, { type: 'triangle', from: 311, to: 277, duration: 0.55, peak: 0.14 });
      break;
    case 'hint':
      tone(ctx, out, now, { from: 1175, duration: 0.3, peak: 0.08 });
      tone(ctx, out, now + 0.09, { from: 1568, duration: 0.4, peak: 0.06 });
      break;
  }
}
