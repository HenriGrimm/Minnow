import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

export type WaveRimTone = 'live' | 'ready' | 'failed' | 'idle';

/**
 * `ring` is a circle centred in a square canvas, with a progress track inside it.
 * `border` traces the rounded border of the canvas's parent element (a card, a round
 * button), `outset` px in from the canvas edge, so the canvas overhangs it and leaves
 * the glow room.
 */
export type WaveRimShape = { kind: 'ring' } | { kind: 'border'; outset: number };

/** Bins around a ring's rim. The rim is a closed string, so ripples wrap and interfere. */
const RING_BINS = 192;
/** A border's bins are spaced like a typical ring's, so ripples travel at the same pace in pixels. */
const BIN_PX = 5.6;
/** A border's rim moves like a ring of this radius (or its short side, if smaller): small swells that stay off the content. */
const BORDER_REACH = 60;
/** 30 Hz keeps the motion fluid while leaving the GPU to a local model between frames. */
const FRAME_MS = 1000 / 30;
/** How long a border's solid shape takes to drain into its rim. */
const MORPH_MS = 520;
/** Silence this long while live means the model is still reading its prompt, so the rim shows it is waiting. */
const QUIET_MS = 700;
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

/** Stretch a closed signal onto a new bin count so a resize mid-stream keeps its ripples. */
function resample(source: Float32Array, length: number) {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const at = index / length * source.length, low = Math.floor(at), mix = at - low;
    out[index] = source[low % source.length] * (1 - mix) + source[(low + 1) % source.length] * mix;
  }
  return out;
}

/** Rest position and outward normal of each bin, walking a rounded rectangle clockwise from its top-left. */
function borderRim(left: number, top: number, w: number, h: number, corner: number, bins: number) {
  const r = Math.max(0, Math.min(corner, w / 2, h / 2));
  const across = w - 2 * r, down = h - 2 * r, arc = Math.PI * r / 2;
  const legs = [across, arc, down, arc, across, arc, down, arc];
  const total = legs.reduce((sum, leg) => sum + leg, 0) || 1;
  const x = new Float32Array(bins), y = new Float32Array(bins), nx = new Float32Array(bins), ny = new Float32Array(bins);
  for (let index = 0; index < bins; index++) {
    let s = index / bins * total, leg = 0;
    while (leg < 7 && s > legs[leg]) s -= legs[leg++];
    const turn = (quarter: number, cx: number, cy: number) => {
      const angle = (quarter - 1) * Math.PI / 2 + (r ? s / r : 0);
      nx[index] = Math.cos(angle); ny[index] = Math.sin(angle);
      x[index] = cx + nx[index] * r; y[index] = cy + ny[index] * r;
    };
    switch (leg) {
      case 0: x[index] = left + r + s; y[index] = top; nx[index] = 0; ny[index] = -1; break;
      case 1: turn(0, left + w - r, top + r); break;
      case 2: x[index] = left + w; y[index] = top + r + s; nx[index] = 1; ny[index] = 0; break;
      case 3: turn(1, left + w - r, top + h - r); break;
      case 4: x[index] = left + w - r - s; y[index] = top + h; nx[index] = 0; ny[index] = 1; break;
      case 5: turn(2, left + r, top + h - r); break;
      case 6: x[index] = left; y[index] = top + h - r - s; nx[index] = -1; ny[index] = 0; break;
      default: turn(3, left + r, top + r);
    }
  }
  return { x, y, nx, ny };
}

/**
 * A glowing rim that behaves like liquid. Streamed text is written into the rim at a
 * rotating head and spreads around it as ripples; tool calls land as larger splashes.
 * Animates only while the tone is `live`; every other tone renders one still frame.
 */
export function mountWaveRim(canvas: HTMLCanvasElement, shape: WaveRimShape) {
  let context: CanvasRenderingContext2D | null = null;
  try { context = canvas.getContext?.('2d') ?? null; } catch { context = null; }
  const ring = shape.kind === 'ring';
  let bins = RING_BINS;
  let field = new Float32Array(bins), velocity = new Float32Array(bins), next = new Float32Array(bins);
  let restX = new Float32Array(bins), restY = new Float32Array(bins), normalX = new Float32Array(bins), normalY = new Float32Array(bins);
  const queue: number[] = [];
  const voice = { sign: 1, level: 0 };
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tone: WaveRimTone = 'idle', progress = 0, energy = 0, head = ring ? -Math.PI / 2 : 0, clock = 0;
  /** 0 → 1 as a border's solid shape drains into its rim when a run starts; a ring has no fill to drain. */
  let morph = 1;
  /** 0 → 1 as a live rim goes quiet: no text is arriving yet, so a droplet circles it instead of ripples. */
  let waiting = 0, silentFor = 0;
  let width = 0, height = 0, scale = 1, reach = BORDER_REACH, colour: Rgb = [158, 197, 167], light = false, paletteAge = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, last = 0, visible = true, disposed = false;

  function palette() {
    const style = canvas.ownerDocument.defaultView!.getComputedStyle(canvas);
    colour = resolveRgb(style.color, colour);
    const [r, g, b] = resolveRgb(style.getPropertyValue('--mn-bg').trim(), [20, 20, 20]);
    light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
    paletteAge = 0;
  }
  function shapeRim() {
    if (shape.kind === 'ring') {
      reach = Math.min(width, height) / 2 * 0.74;
      for (let index = 0; index < bins; index++) {
        const angle = index / bins * TAU;
        normalX[index] = Math.cos(angle); normalY[index] = Math.sin(angle);
        restX[index] = width / 2 + normalX[index] * reach; restY[index] = height / 2 + normalY[index] * reach;
      }
      return;
    }
    const w = Math.max(0, width - 2 * shape.outset), h = Math.max(0, height - 2 * shape.outset);
    reach = Math.min(BORDER_REACH, w, h);
    // Small borders get extra bins so their ripples stay fine instead of blobby.
    const wanted = Math.max(160, Math.min(512, Math.round((2 * (w + h)) / BIN_PX)));
    if (wanted !== bins) {
      field = resample(field, wanted); velocity = resample(velocity, wanted); next = new Float32Array(wanted);
      bins = wanted;
    }
    const parent = canvas.parentElement;
    const corner = parent ? parseFloat(canvas.ownerDocument.defaultView!.getComputedStyle(parent).borderTopLeftRadius) || 0 : 0;
    ({ x: restX, y: restY, nx: normalX, ny: normalY } = borderRim(shape.outset, shape.outset, w, h, corner, bins));
  }
  function resize() {
    const box = canvas.getBoundingClientRect();
    scale = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    width = box.width; height = box.height;
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    shapeRim();
    draw();
  }

  function step(dt: number) {
    // Drain queued samples so each snapshot's text plays out before the next one lands.
    const drain = queue.length ? Math.max(1, Math.ceil(queue.length * Math.min(1, dt / 260))) : 0;
    for (let index = 0; index < drain; index++) {
      const sample = queue.shift()!;
      const bin = ((Math.round(head / TAU * bins) % bins) + bins) % bins;
      for (let offset = -5; offset <= 5; offset++) velocity[(bin + offset + bins) % bins] += sample * 0.16 * Math.exp(-offset * offset / 8);
      head += TAU / bins * 0.4;
    }
    const target = Math.min(1, drain / Math.max(dt, 1) * 1000 / 70);
    energy += (target - energy) * Math.min(1, dt / (target > energy ? 180 : 900));
    silentFor = drain ? 0 : silentFor + dt;
    // Text arriving snaps the rim out of waiting; silence eases it in.
    const wanted = silentFor >= QUIET_MS ? 1 : 0;
    waiting += (wanted - waiting) * Math.min(1, dt / (wanted > waiting ? 500 : 140));
    // The head drifts at the same pixel pace whatever the rim's length; a waiting head laps the rim.
    head += dt / 1000 * (0.32 + energy * 0.9 + waiting * (ring ? 1.5 : 0.8)) * RING_BINS / bins;
    clock += dt / 1000;
    morph = Math.min(1, morph + dt / MORPH_MS);
    // A damped wave equation on a closed string, a few small substeps per frame for stability.
    const substeps = Math.min(6, Math.max(1, Math.round(dt / 8)));
    for (let pass = 0; pass < substeps; pass++) {
      for (let index = 0; index < bins; index++) {
        const left = field[(index + bins - 1) % bins], right = field[(index + 1) % bins];
        velocity[index] += 0.3 * (left + right - 2 * field[index]) - 0.01 * field[index];
        velocity[index] *= 0.988;
      }
      for (let index = 0; index < bins; index++) next[index] = field[index] + velocity[index] * 0.5;
      field.set(next);
    }
  }

  function rim(inset: number, amplitude: number, lag: number, ambient: number, droplet = 0) {
    const points: Array<[number, number]> = [];
    const at = (((head / TAU * bins) % bins) + bins) % bins;
    for (let index = 0; index < bins; index++) {
      const angle = index / bins * TAU;
      const sample = field[(index + lag + bins) % bins];
      const breath = ambient * (Math.sin(3 * angle - clock * 0.7) + 0.6 * Math.sin(5 * angle + clock * 0.45) + 0.35 * Math.sin(2 * angle + clock * 1.1));
      let offset = Math.tanh(sample) * amplitude + breath - inset;
      if (droplet) {
        // A swell riding the head, its distance measured the short way round the closed rim.
        const apart = Math.abs(index + lag - at) % bins, gap = Math.min(apart, bins - apart);
        offset += droplet * Math.exp(-gap * gap / 50);
      }
      points.push([restX[index] + normalX[index] * offset, restY[index] + normalY[index] * offset]);
    }
    context!.beginPath();
    const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
    const start = mid(points[bins - 1], points[0]);
    context!.moveTo(start[0], start[1]);
    for (let index = 0; index < bins; index++) {
      const point = points[index], after = mid(point, points[(index + 1) % bins]);
      context!.quadraticCurveTo(point[0], point[1], after[0], after[1]);
    }
    context!.closePath();
  }

  /** Where the head sits as seen from the centre, interpolated between bins so the comet glides. */
  function headAngle() {
    const at = (((head / TAU * bins) % bins) + bins) % bins, low = Math.floor(at) % bins, high = (low + 1) % bins, mix = at - Math.floor(at);
    const x = restX[low] * (1 - mix) + restX[high] * mix, y = restY[low] * (1 - mix) + restY[high] * mix;
    return Math.atan2(y - height / 2, x - width / 2);
  }

  function draw() {
    if (!context || !width || !height) return;
    // A canvas that cannot paint must never take its host view down with it.
    try { paintFrame(context); } catch { context = null; halt(); }
  }
  function paintFrame(context: CanvasRenderingContext2D) {
    if (paletteAge++ > 60) palette();
    const live = tone === 'live';
    const settle = 1 - (1 - morph) ** 3;
    // A border shivers rather than sloshes: lower swells and almost no slow breathing.
    const amplitude = reach * (ring ? 1 : 0.5) * (live ? 0.05 + energy * 0.07 : 0.04) * settle;
    const ambient = reach * (ring ? 1 : 0.3) * (live ? 0.008 + energy * 0.006 : tone === 'failed' ? 0.004 : 0.006) * settle;
    // Waiting on the model: the glow breathes and a droplet circles the rim, so a quiet prefill never looks stalled.
    // Beside the composer's controls the waiting motion stays quiet: a faint swell, a gentle breath.
    const hold = live ? waiting * settle * (ring ? 1 : 0.4) : 0;
    const droplet = reach * (ring ? 0.09 : 0.1) * hold * (0.8 + 0.2 * Math.sin(clock * 5));
    const glow = (tone === 'idle' ? 0.35 : tone === 'failed' ? 0.55 : live ? 0.7 + energy * 0.3 : 0.8) * (0.4 + 0.6 * settle) * (1 + hold * 0.18 * Math.sin(clock * 2.6));
    // A border sits among other controls, so its rim is a hairline with a tight halo.
    const bloom = ring ? 1 : 0.4;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = 'round'; context.lineJoin = 'round';

    if (ring) {
      // Progress runs on a quiet inner track, out of the wave's way.
      const track = reach * 0.86;
      context.lineWidth = 1.5;
      context.strokeStyle = rgba(colour, light ? 0.16 : 0.12);
      context.beginPath(); context.arc(width / 2, height / 2, track, 0, TAU); context.stroke();
      if (progress > 0) {
        context.strokeStyle = rgba(colour, 0.65);
        context.beginPath(); context.arc(width / 2, height / 2, track, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, progress / 100)); context.stroke();
      }
    }

    // The comet: brightest at the write head, fading back along the trail it left.
    const start = live ? headAngle() : 0;
    const stroke = (alpha: number) => {
      if (!live || typeof context.createConicGradient !== 'function') return rgba(colour, alpha);
      const gradient = context.createConicGradient(start, width / 2, height / 2);
      gradient.addColorStop(0, rgba(colour, alpha * 0.85)); gradient.addColorStop(0.05, rgba(colour, alpha * 0.32));
      // A waiting comet's tail fades further, so it reads as one bright light lapping the rim.
      gradient.addColorStop(0.55, rgba(colour, alpha * (0.28 - hold * 0.18))); gradient.addColorStop(1, rgba(colour, alpha));
      return gradient;
    };
    if (settle < 1) {
      // The shape starts solid, matching the button it grew from, and drains into the rim.
      rim(0, amplitude, 0, ambient);
      context.fillStyle = rgba(colour, 1 - settle); context.fill();
    }
    context.globalCompositeOperation = light ? 'source-over' : 'lighter';
    // A slower, deeper echo inside the main rim gives the liquid its body.
    rim(reach * 0.035, amplitude * 0.6, -9, ambient * 1.4, droplet * 0.6);
    context.lineWidth = ring ? 1.25 : 0.75; context.strokeStyle = stroke(0.35 * glow); context.stroke();
    rim(0, amplitude, 0, ambient, droplet);
    context.shadowColor = rgba(colour, light ? 0.35 : 0.85); context.shadowBlur = (light ? 10 : 26) * glow * bloom;
    context.lineWidth = ring ? 7 : 3; context.strokeStyle = stroke(0.16 * glow); context.stroke();
    context.shadowBlur = (light ? 4 : 12) * glow * bloom;
    context.lineWidth = ring ? 2.25 : 1; context.strokeStyle = stroke(glow); context.stroke();
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
    set(nextTone: WaveRimTone, nextProgress = 0) {
      const changed = nextTone !== tone;
      tone = nextTone; progress = nextProgress; canvas.dataset.tone = tone;
      if (changed) {
        if (context) { try { palette(); } catch { context = null; } }
        if (tone === 'live' && !ring && !reducedMotion) morph = 0;
        // A run starts with the model reading its prompt, so it waits until text says otherwise.
        if (tone === 'live') silentFor = QUIET_MS;
        else { morph = 1; waiting = 0; field.fill(0); velocity.fill(0); queue.length = 0; energy = 0; halt(); }
      }
      if (tone === 'live' && !reducedMotion) schedule(); else draw();
    },
    dispose() { disposed = true; halt(); resizer?.disconnect(); intersection?.disconnect(); disposeIdle(); },
  };
}
