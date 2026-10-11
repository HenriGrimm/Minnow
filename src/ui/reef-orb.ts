import { mountWaveRim, type WaveRimTone } from './wave-rim';

export type ReefOrbTone = WaveRimTone;

/** The Build view's ring: a liquid rim around the run's stage, with progress on an inner track. */
export function mountReefOrb(canvas: HTMLCanvasElement) {
  return mountWaveRim(canvas, { kind: 'ring' });
}
