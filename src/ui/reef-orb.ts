import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

export type ReefOrbTone = 'live' | 'ready' | 'failed' | 'idle';

/** Bins around the rim. The rim is a closed string, so ripples wrap and interfere. */
const BINS = 192;
/** 30 Hz keeps the motion fluid while leaving the GPU to a local model between frames. */
const FRAME_MS = 1000 / 30;
const TAU = Math.PI * 2;

type Rgb = [number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;
/** Canvas understands every CSS colour syntax the themes use (hex, oklch, color-mix). */
function resolveRgb(color: string, fallback: Rgb): Rgb {
  if (probe === undefined) {
    try { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; probe = canvas.getContext('2d', { willReadFrequently: true }); }
    catch { probe = null; }
  }
  if (!probe || !color) return fallback;
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}
const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;

/**
 * Each word becomes one swell and the gaps between words let the rim settle, so prose
 * reads like speech. Swells alternate direction word by word, and a low-pass keeps the
 * shape rounded rather than jagged.
 */
function samplesFor(text: string, stride: number, voice: { sign: number; level: number }) {
  const samples: number[] = [];
  for (let index = 0; index < text.length; index += stride) {
    const char = text[index];
    let target = 0;
    if (/\s/.test(char)) { if (voice.level !== 0) voice.sign = -voice.sign; }
    else {
      const code = char.codePointAt(0) ?? 0;
      target = voice.sign * (/[A-Za-z0-9]/.test(char) ? 0.45 + 0.55 * ((code * 37) % 97) / 97 : 1);
    }
    voice.level += (target - voice.level) * 0.35;
    samples.push(voice.level);
  }
  return samples;
}

/**
 * A glowing ring whose rim behaves like liquid. Streamed text is written into the rim at a
 * rotating head and spreads around it as ripples; tool calls land as larger splashes.
 * Animates only while the tone is `live`; every other tone renders one still frame.
 */
export function mountReefOrb(canvas: HTMLCanvasElement) {
  let context: CanvasRenderingContext2D | null = null;
  try { context = canvas.getContext?.('2d') ?? null; } catch { context = null; }
  const field = new Float32Array(BINS), velocity = new Float32Array(BINS), next = new Float32Array(BINS);
  const queue: number[] = [];
  const voice = { sign: 1, level: 0 };
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tone: ReefOrbTone = 'idle', progress = 0, energy = 0, head = -Math.PI / 2, clock = 0;
  let width = 0, height = 0, scale = 1, colour: Rgb = [158, 197, 167], light = false, paletteAge = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, last = 0, visible = true, disposed = false;

  function palette() {
    const style = canvas.ownerDocument.defaultView!.getComputedStyle(canvas);
    colour = resolveRgb(style.color, colour);
    const [r, g, b] = resolveRgb(style.getPropertyValue('--mn-bg').trim(), [20, 20, 20]);
    light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
    paletteAge = 0;
  }
  function resize() {
    const box = canvas.getBoundingClientRect();
    scale = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    width = box.width; height = box.height;
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    draw();
  }

  function step(dt: number) {
    // Drain queued samples so each snapshot's text plays out before the next one lands.
    const drain = queue.length ? Math.max(1, Math.ceil(queue.length * Math.min(1, dt / 260))) : 0;
    for (let index = 0; index < drain; index++) {
      const sample = queue.shift()!;
      const bin = ((Math.round(head / TAU * BINS) % BINS) + BINS) % BINS;
      for (let offset = -5; offset <= 5; offset++) velocity[(bin + offset + BINS) % BINS] += sample * 0.16 * Math.exp(-offset * offset / 8);
      head += TAU / BINS * 0.4;
    }
    const target = Math.min(1, drain / Math.max(dt, 1) * 1000 / 70);
    energy += (target - energy) * Math.min(1, dt / (target > energy ? 180 : 900));
    head += dt / 1000 * (0.32 + energy * 0.9);
    clock += dt / 1000;
    // A damped wave equation on a ring, a few small substeps per frame for stability.
    const substeps = Math.min(6, Math.max(1, Math.round(dt / 8)));
    for (let pass = 0; pass < substeps; pass++) {
      for (let index = 0; index < BINS; index++) {
        const left = field[(index + BINS - 1) % BINS], right = field[(index + 1) % BINS];
        velocity[index] += 0.3 * (left + right - 2 * field[index]) - 0.01 * field[index];
        velocity[index] *= 0.988;
      }
      for (let index = 0; index < BINS; index++) next[index] = field[index] + velocity[index] * 0.5;
      field.set(next);
    }
  }

  function rim(radius: number, amplitude: number, lag: number, ambient: number) {
    const points: Array<[number, number]> = [];
    const centreX = width / 2, centreY = height / 2;
    for (let index = 0; index < BINS; index++) {
      const angle = index / BINS * TAU;
      const sample = field[(index + lag + BINS) % BINS];
      const breath = ambient * (Math.sin(3 * angle - clock * 0.7) + 0.6 * Math.sin(5 * angle + clock * 0.45) + 0.35 * Math.sin(2 * angle + clock * 1.1));
      const r = radius + Math.tanh(sample) * amplitude + breath;
      points.push([centreX + Math.cos(angle) * r, centreY + Math.sin(angle) * r]);
    }
    context!.beginPath();
    const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
    const start = mid(points[BINS - 1], points[0]);
    context!.moveTo(start[0], start[1]);
    for (let index = 0; index < BINS; index++) {
      const point = points[index], after = mid(point, points[(index + 1) % BINS]);
      context!.quadraticCurveTo(point[0], point[1], after[0], after[1]);
    }
    context!.closePath();
  }

  function draw() {
    if (!context || !width || !height) return;
    // A canvas that cannot paint must never take the build view down with it.
    try { paintFrame(context); } catch { context = null; halt(); }
  }
  function paintFrame(context: CanvasRenderingContext2D) {
    if (paletteAge++ > 60) palette();
    const live = tone === 'live';
    const radius = Math.min(width, height) / 2 * 0.74;
    const amplitude = radius * (live ? 0.05 + energy * 0.07 : 0.04);
    const ambient = radius * (live ? 0.008 + energy * 0.006 : tone === 'failed' ? 0.004 : 0.006);
    const glow = tone === 'idle' ? 0.35 : tone === 'failed' ? 0.55 : live ? 0.7 + energy * 0.3 : 0.8;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = 'round'; context.lineJoin = 'round';

    // Progress runs on a quiet inner track, out of the wave's way.
    const track = radius * 0.86;
    context.lineWidth = 1.5;
    context.strokeStyle = rgba(colour, light ? 0.16 : 0.12);
    context.beginPath(); context.arc(width / 2, height / 2, track, 0, TAU); context.stroke();
    if (progress > 0) {
      context.strokeStyle = rgba(colour, 0.65);
      context.beginPath(); context.arc(width / 2, height / 2, track, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, progress / 100)); context.stroke();
    }

    // The comet: brightest at the write head, fading back along the trail it left.
    const stroke = (alpha: number) => {
      if (!live || typeof context.createConicGradient !== 'function') return rgba(colour, alpha);
      const gradient = context.createConicGradient(head, width / 2, height / 2);
      gradient.addColorStop(0, rgba(colour, alpha * 0.85)); gradient.addColorStop(0.05, rgba(colour, alpha * 0.32));
      gradient.addColorStop(0.55, rgba(colour, alpha * 0.28)); gradient.addColorStop(1, rgba(colour, alpha));
      return gradient;
    };
    context.globalCompositeOperation = light ? 'source-over' : 'lighter';
    // A slower, deeper echo inside the main rim gives the liquid its body.
    rim(radius * 0.965, amplitude * 0.6, -9, ambient * 1.4);
    context.lineWidth = 1.25; context.strokeStyle = stroke(0.35 * glow); context.stroke();
    rim(radius, amplitude, 0, ambient);
    context.shadowColor = rgba(colour, light ? 0.35 : 0.85); context.shadowBlur = (light ? 10 : 26) * glow;
    context.lineWidth = 7; context.strokeStyle = stroke(0.16 * glow); context.stroke();
    context.shadowBlur = (light ? 4 : 12) * glow;
    context.lineWidth = 2.25; context.strokeStyle = stroke(glow); context.stroke();
    context.shadowBlur = 0; context.globalCompositeOperation = 'source-over';
  }

  function tick(now: number) {
    timer = undefined; frame = 0;
    if (disposed || !visible || tone !== 'live' || reducedMotion) return;
    const dt = Math.min(100, last ? now - last : FRAME_MS); last = now;
    step(dt); draw(); schedule();
  }
  function schedule() {
    if (disposed || timer || frame || !visible || tone !== 'live' || reducedMotion || !context) return;
    // Wait on a timer, then align the draw to vsync: frames at 30 Hz, never per refresh.
    timer = setTimeout(() => {
      timer = undefined;
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
      else tick(performance.now());
    }, FRAME_MS);
  }
  function halt() {
    if (timer) clearTimeout(timer);
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    timer = undefined; frame = 0; last = 0;
  }

  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  resizer?.observe(canvas);
  const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting) && !isRenderIdle();
    if (visible) schedule(); else halt();
  }) : null;
  intersection?.observe(canvas);
  const disposeIdle = subscribeRenderIdle(idle => { visible = !idle; if (visible) schedule(); else halt(); });
  if (context) { try { palette(); resize(); } catch { context = null; } }

  return {
    /** Newly streamed text: each character becomes a sample written at the head. */
    feed(text: string, gain = 1) {
      if (!text || tone !== 'live') return;
      const stride = Math.max(1, Math.ceil(text.length / 220));
      for (const sample of samplesFor(text, stride, voice)) queue.push(sample * gain);
      if (queue.length > 900) queue.splice(0, queue.length - 900);
      schedule();
    },
    /** A splash at the head, for tool calls and stage changes. */
    pulse(strength = 1) {
      if (tone !== 'live') return;
      queue.push(strength * 0.6, strength * 1.4, strength * 1.8, strength * 1.2, strength * 0.4);
      energy = Math.min(1, energy + strength * 0.25);
      schedule();
    },
    set(nextTone: ReefOrbTone, nextProgress: number) {
      const changed = nextTone !== tone;
      tone = nextTone; progress = nextProgress; canvas.dataset.tone = tone;
      if (changed) { if (context) { try { palette(); } catch { context = null; } } if (tone !== 'live') { field.fill(0); velocity.fill(0); queue.length = 0; energy = 0; halt(); } }
      if (tone === 'live' && !reducedMotion) schedule(); else draw();
    },
    dispose() { disposed = true; halt(); resizer?.disconnect(); intersection?.disconnect(); disposeIdle(); },
  };
}
